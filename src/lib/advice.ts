// 작업 조언 파이프라인. 처리 순서는 원안 §7.2 를 따른다:
//   권한 → 현재 상태·버전 → 관련성 → 근거·조건 → 출처·AI 추가 구분 → 확정 직전 재확인
//
// AI 미연결(provider.isAi=false)일 때는 모델을 부르지 않고, 키워드가 겹치는 공유 메모를
// "팀 메모에 있는 내용"으로만 보여준다. 연결 이유·활용 제안·반론은 만들지 않는다 (지어내지 않음).
import { requireMembership } from "./access.ts";
import { AiTimeout, aiTimeoutMs, withTimeout } from "./ai/timeout.ts";
import type { AiProvider, CandidateForAi, DeclinedForAi, TaskContext } from "./ai/types.ts";
import {
  InvalidAiOutput,
  parseJudgments,
  proposalKey,
  validateAdviceOutput,
  type SourceNote,
  type ValidItem,
} from "./ai/validate-output.ts";
import { audit, getPool, withTx, type Db } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { findCandidates, type Candidate } from "./search.ts";
import { clip, optionalText, uuid } from "./validate.ts";

const MAX_CANDIDATES = 20;
/** AI 모드에서 공유 메모가 이 개수 이하인 작은 팀이면, 키워드가 안 겹쳐도 전부 판정 대상으로 */
const SMALL_TEAM_ALL = 30;
/** 처리 중 상태가 이보다 오래되면 중단된 것으로 본다 */
const STALE_MS = 5 * 60 * 1000;

export const REACTIONS = ["apply", "hold", "exclude"] as const;
export type Reaction = (typeof REACTIONS)[number];

class AiCallError extends Error {
  constructor(cause: unknown) {
    super("AI call failed");
    this.name = cause instanceof AiTimeout ? "AiTimeout" : "AiCallError";
  }
}

async function callAi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(fn(), aiTimeoutMs());
  } catch (err) {
    if (err instanceof AiTimeout) throw err;
    throw new AiCallError(err);
  }
}

function errorCode(err: unknown): string {
  if (err instanceof AiTimeout) return "ai_timeout";
  if (err instanceof InvalidAiOutput) return "invalid_ai_output";
  if (err instanceof AiCallError) return "ai_error";
  return "internal";
}

function taskContext(task: Record<string, string>, question: string): TaskContext {
  return {
    title: task.title ?? "",
    purpose: task.purpose ?? "",
    audience: task.audience ?? "",
    constraints: task.constraints ?? "",
    question,
  };
}

const contextQuery = (c: TaskContext) => [c.title, c.purpose, c.audience, c.constraints, c.question].filter(Boolean).join("\n");

/** 맥락이 부족할 때 보여줄 짧은 안내 (요청을 막지는 않음, 원안 §7.2-3) */
function contextHints(c: TaskContext): string[] {
  const hints: string[] = [];
  if (!c.purpose) hints.push("목적을 적으면 더 관련 있는 메모를 찾을 수 있어요.");
  if (!c.audience) hints.push("대상(누구를 위한 작업인지)을 적으면 더 정확해져요.");
  return hints;
}

type PipelineResult = {
  items: ValidItem[];
  dropped: number;
  emptyReason: string | null;
  inputIds: string[];
};

function keywordItems(cands: Candidate[]): ValidItem[] {
  return cands.map((c) => ({
    section: "direct",
    body: c.summary ?? clip(c.rawText, 300),
    evidence: [{ versionId: c.versionId, quote: clip(c.rawText, 120) }],
    action: "keyword-match",
  }));
}

/** 모델·화면에 넘길 메모를 먼저 기록하고, 기록 직후 다시 확인해 그 사이 철회된 메모는 뺀다. */
async function recordInputs(requestId: string, teamId: string, cands: Candidate[]): Promise<Candidate[]> {
  const db = getPool();
  const ids = cands.map((c) => c.versionId);
  await db.query("update advice_requests set input_version_ids = $2, candidate_count = $3 where id = $1", [
    requestId,
    ids,
    ids.length,
  ]);
  const ok = await db.query(
    `select v.id from note_versions v join notes n on n.current_version_id = v.id
     where v.id = any($1::uuid[]) and n.team_id = $2 and n.share_state = 'shared'`,
    [ids, teamId],
  );
  const live = new Set(ok.rows.map((r) => r.id as string));
  return cands.filter((c) => live.has(c.versionId));
}

async function declinedFor(taskId: string, userId: string, refByVersion: Map<string, string>): Promise<DeclinedForAi[]> {
  const r = await getPool().query(
    `select r.reaction, r.evidence_version_ids, i.action
     from reactions r left join advice_items i on i.id = r.advice_item_id
     where r.task_id = $1 and r.user_id = $2 and r.reaction in ('hold', 'exclude')
     order by r.updated_at desc limit 20`,
    [taskId, userId],
  );
  return r.rows
    .map((x) => ({
      reaction: x.reaction as "hold" | "exclude",
      action: (x.action as string | null) ?? null,
      refs: (x.evidence_version_ids as string[]).map((v) => refByVersion.get(v)).filter((v): v is string => !!v),
    }))
    .filter((d) => d.refs.length > 0);
}

async function runPipeline(
  userId: string,
  task: Record<string, string>,
  ctx: TaskContext,
  requestId: string,
  provider: AiProvider,
): Promise<PipelineResult> {
  const found = await findCandidates(task.team_id!, contextQuery(ctx), {
    requireExternalAi: provider.isAi,
    limit: MAX_CANDIDATES,
    includeAllIfAtMost: provider.isAi ? SMALL_TEAM_ALL : 0,
  });
  if (!found.length) return { items: [], dropped: 0, emptyReason: "no_related_notes", inputIds: [] };

  const live = await recordInputs(requestId, task.team_id!, found);
  const inputIds = live.map((c) => c.versionId);
  if (!live.length) return { items: [], dropped: 0, emptyReason: "no_related_notes", inputIds };

  if (!provider.isAi) return { items: keywordItems(live), dropped: 0, emptyReason: null, inputIds };

  // 요청 한정 번호: 모델은 실제 ID·작성자를 모른다
  const byRef = new Map<string, Candidate>(live.map((c, i) => [`N${i + 1}`, c]));
  const forAi = (ref: string, c: Candidate): CandidateForAi => ({
    ref,
    text: c.rawText,
    summary: c.summary,
    conditions: c.conditions,
  });

  const judgedRaw = await callAi(() =>
    provider.judge({ task: ctx, candidates: [...byRef].map(([ref, c]) => forAi(ref, c)) }),
  );
  const judged = parseJudgments(judgedRaw, new Set(byRef.keys()));
  if (!judged.relevant.length) return { items: [], dropped: judged.dropped, emptyReason: "no_related_notes", inputIds };

  const relevant = judged.relevant.map((j) => ({ ...forAi(j.ref, byRef.get(j.ref)!), stance: j.stance }));
  const refByVersion = new Map(judged.relevant.map((j) => [byRef.get(j.ref)!.versionId, j.ref]));
  const declined = await declinedFor(task.id!, userId, refByVersion);

  const adviseRaw = await callAi(() => provider.advise({ task: ctx, notes: relevant, declined }));
  const sources = new Map<string, SourceNote>(
    judged.relevant.map((j) => {
      const c = byRef.get(j.ref)!;
      return [j.ref, { versionId: c.versionId, rawText: c.rawText, summary: c.summary }];
    }),
  );
  const v = validateAdviceOutput(adviseRaw, sources);
  return {
    items: v.items,
    dropped: judged.dropped + v.dropped,
    emptyReason: v.items.length ? null : "no_valid_items",
    inputIds,
  };
}

async function invalidateRequest(tx: Db, requestId: string, reason: string) {
  await tx.query(
    "update advice_requests set status = 'invalidated', error = $2, finished_at = now() where id = $1 and status = 'pending'",
    [requestId, reason],
  );
}

/**
 * 확정: 저장 직전에 근거 메모·작업·요청자 상태를 다시 확인한다 (원안 §7.2-10).
 * 잠금 순서는 메모 → 작업 → 조언 요청. 철회·수정(메모 → 조언 요청)과 같은 순서라 교착이 생기지 않는다.
 */
async function finalize(
  requestId: string,
  userId: string,
  teamId: string,
  taskId: string,
  taskVersion: number,
  res: PipelineResult,
) {
  await withTx(async (tx) => {
    if (res.inputIds.length) {
      const live = await tx.query(
        `select v.id from note_versions v join notes n on n.id = v.note_id
         where v.id = any($1::uuid[]) and n.team_id = $2 and n.current_version_id = v.id and n.share_state = 'shared'
         for share of n`,
        [res.inputIds, teamId],
      );
      if (live.rowCount !== res.inputIds.length) return invalidateRequest(tx, requestId, "source_changed");
    }
    const t = await tx.query("select version from tasks where id = $1 for share", [taskId]);
    if (!t.rowCount || t.rows[0].version !== taskVersion) return invalidateRequest(tx, requestId, "task_changed");
    const m = await tx.query(
      "select 1 from memberships where team_id = $1 and user_id = $2 and status = 'active'",
      [teamId, userId],
    );
    if (!m.rowCount) return invalidateRequest(tx, requestId, "requester_left");

    const r = await tx.query("select status from advice_requests where id = $1 for update", [requestId]);
    if (r.rows[0]?.status !== "pending") return; // 그 사이 철회 등으로 이미 무효화됨

    for (const [i, item] of res.items.entries()) {
      await tx.query(
        `insert into advice_items (request_id, section, body, evidence_version_ids, quotes, action, proposal_key, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          requestId,
          item.section,
          item.body,
          item.evidence.map((e) => e.versionId),
          JSON.stringify(item.evidence),
          item.action,
          proposalKey(item),
          i,
        ],
      );
    }
    await tx.query(
      `update advice_requests set status = 'ok', dropped_count = $2, empty_reason = $3, finished_at = now()
       where id = $1`,
      [requestId, res.dropped, res.emptyReason],
    );
  });
}

export async function requestAdvice(
  userId: string,
  taskId: string,
  input: { question?: unknown; clientRequestId?: unknown },
  provider: AiProvider,
) {
  const question = optionalText(input.question, "질문", 1000);
  const clientRequestId =
    input.clientRequestId === undefined || input.clientRequestId === null
      ? null
      : uuid(input.clientRequestId, "clientRequestId");
  const db = getPool();
  const t = await db.query("select * from tasks where id = $1", [taskId]);
  const task = t.rows[0];
  if (!task) throw notFound();
  await requireMembership(db, userId, task.team_id);
  const ctx = taskContext(task, question);

  // 같은 버튼을 두 번 눌러도 요청은 하나만 (clientRequestId)
  const ins = await db.query(
    `insert into advice_requests (team_id, task_id, requester_id, task_version, context, question, provider, client_request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (requester_id, client_request_id) where client_request_id is not null do nothing
     returning id`,
    [task.team_id, task.id, userId, task.version, JSON.stringify(ctx), question, provider.name, clientRequestId],
  );
  if (!ins.rowCount) {
    const ex = await db.query("select id from advice_requests where requester_id = $1 and client_request_id = $2", [
      userId,
      clientRequestId,
    ]);
    return getAdvice(userId, ex.rows[0].id);
  }
  const requestId = ins.rows[0].id as string;
  await audit(db, userId, "advice.request", requestId, { provider: provider.name });

  try {
    const res = await runPipeline(userId, task, ctx, requestId, provider);
    await finalize(requestId, userId, task.team_id, task.id, task.version, res);
  } catch (err) {
    const code = errorCode(err);
    console.error("advice failed", code, (err as Error)?.name);
    await db.query(
      "update advice_requests set status = 'failed', error = $2, finished_at = now() where id = $1 and status = 'pending'",
      [requestId, code],
    );
  }
  return getAdvice(userId, requestId);
}

type EvidenceView =
  | { versionId: string; available: false }
  | {
      versionId: string;
      available: true;
      noteId: string;
      authorName: string;
      text: string;
      summary: string | null;
      quote: string | null;
    };

/** 조언 보기. 다시 열 때마다 근거 메모의 현재 상태를 확인해, 철회·수정·삭제된 근거에 기댄 항목은 숨긴다. */
export async function getAdvice(userId: string, requestId: string) {
  const db = getPool();
  const r = await db.query(
    `select r.*, t.version as current_task_version
     from advice_requests r join tasks t on t.id = r.task_id where r.id = $1`,
    [requestId],
  );
  const req = r.rows[0];
  if (!req) throw notFound();
  await requireMembership(db, userId, req.team_id);
  if (req.requester_id !== userId) throw notFound(); // 조언은 요청한 사람에게만 보인다

  const stale = req.status === "pending" && Date.now() - new Date(req.created_at).getTime() > STALE_MS;
  const status: string = stale ? "failed" : req.status;
  const error: string | null = stale ? "stale" : req.error;

  const itemsR = await db.query("select * from advice_items where request_id = $1 order by position", [requestId]);
  const ids = [...new Set(itemsR.rows.flatMap((i) => i.evidence_version_ids as string[]))];
  const ev = ids.length
    ? await db.query(
        `select v.id, v.raw_text, v.restated, n.id as note_id, u.display_name,
                (n.current_version_id = v.id and n.share_state = 'shared') as available
         from note_versions v join notes n on n.id = v.note_id join users u on u.id = n.author_id
         where v.id = any($1::uuid[]) and n.team_id = $2`,
        [ids, req.team_id],
      )
    : { rows: [] as Record<string, any>[] };
  const evMap = new Map(ev.rows.map((e) => [e.id as string, e]));
  const rx = await db.query(
    "select proposal_key, reaction, reason, updated_at from reactions where task_id = $1 and user_id = $2",
    [req.task_id, userId],
  );
  const rxMap = new Map(rx.rows.map((x) => [x.proposal_key as string, x]));

  const items = itemsR.rows.map((i) => {
    const quotes = i.quotes as { versionId: string; quote: string | null }[];
    const evidence: EvidenceView[] = (i.evidence_version_ids as string[]).map((vid) => {
      const e = evMap.get(vid);
      if (!e || !e.available) return { versionId: vid, available: false };
      return {
        versionId: vid,
        available: true,
        noteId: e.note_id,
        authorName: e.display_name,
        text: e.raw_text,
        summary: e.restated?.summary ?? null,
        quote: quotes.find((q) => q.versionId === vid)?.quote ?? null,
      };
    });
    const hidden = status === "invalidated" || i.purged || evidence.some((e) => !e.available);
    const mine = rxMap.get(i.proposal_key);
    return {
      id: i.id as string,
      section: i.section as string,
      body: hidden ? null : (i.body as string),
      hidden,
      evidence: hidden ? evidence.map((e) => ({ versionId: e.versionId, available: false as const })) : evidence,
      myReaction: mine ? { reaction: mine.reaction as Reaction, reason: (mine.reason as string | null) ?? null } : null,
      /** 이 요청 전에 이미 보류·제외한 제안 → 화면에서 접어서 보여준다 */
      declinedEarlier: !!mine && mine.reaction !== "apply" && new Date(mine.updated_at) < new Date(req.created_at),
    };
  });

  const ctx = JSON.parse(req.context) as TaskContext;
  return {
    id: req.id as string,
    taskId: req.task_id as string,
    status,
    error,
    provider: req.provider as string,
    emptyReason: (req.empty_reason as string | null) ?? null,
    droppedCount: req.dropped_count as number,
    candidateCount: req.candidate_count as number,
    createdAt: req.created_at as string,
    question: req.question as string,
    taskChanged: req.current_task_version !== req.task_version,
    hints: status === "ok" ? contextHints(ctx) : [],
    items,
  };
}

/** 이 작업에서 내가 요청한 조언 목록 */
export async function listAdviceRequests(userId: string, taskId: string) {
  const db = getPool();
  const t = await db.query("select team_id from tasks where id = $1", [taskId]);
  if (!t.rowCount) throw notFound();
  await requireMembership(db, userId, t.rows[0].team_id);
  const r = await db.query(
    `select r.id, r.status, r.provider, r.created_at, r.error,
            (select count(*) from advice_items i where i.request_id = r.id)::int as item_count
     from advice_requests r where r.task_id = $1 and r.requester_id = $2
     order by r.created_at desc limit 20`,
    [taskId, userId],
  );
  return r.rows;
}

/** 적용·보류·제외 기록. 작업 담당자 개인의 판단이며 팀 합의와는 다르다 (원안 §4.1-9). */
export async function reactToItem(userId: string, itemId: string, input: { reaction: unknown; reason?: unknown }) {
  if (!REACTIONS.includes(input.reaction as Reaction)) throw badRequest("반응 값이 올바르지 않습니다.");
  const reaction = input.reaction as Reaction;
  const reason = optionalText(input.reason, "이유", 300) || null;
  return withTx(async (tx) => {
    const r = await tx.query(
      `select i.id, i.proposal_key, i.evidence_version_ids, i.purged, q.task_id, q.team_id, q.requester_id, q.status
       from advice_items i join advice_requests q on q.id = i.request_id where i.id = $1`,
      [itemId],
    );
    const row = r.rows[0];
    if (!row) throw notFound();
    await requireMembership(tx, userId, row.team_id);
    if (row.requester_id !== userId) throw notFound();
    if (row.status !== "ok" || row.purged) throw conflict("무효가 된 조언에는 반응할 수 없습니다.");
    await tx.query(
      `insert into reactions (task_id, proposal_key, user_id, reaction, reason, evidence_version_ids, advice_item_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (task_id, proposal_key, user_id) do update
         set reaction = excluded.reaction, reason = excluded.reason,
             evidence_version_ids = excluded.evidence_version_ids, advice_item_id = excluded.advice_item_id,
             updated_at = now()`,
      [row.task_id, row.proposal_key, userId, reaction, reason, row.evidence_version_ids, itemId],
    );
    await audit(tx, userId, "advice.react", itemId, { reaction });
    return { itemId, reaction, reason };
  });
}
