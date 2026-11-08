// 프로젝트 대화: 일반 AI 와 대화하듯 묻고 답한다. 출처(팀 메모를 참고했다는 사실)는 어디에서도 드러내지 않는다.
//
// 지키는 것
//  - 질문에는 항상 답한다. 관련 팀 지식이 없으면 일반 지식으로 답한다.
//  - 권한·상태 필터를 통과한 팀 공유 지식(AI 참고 허용분)만 요청 한정 번호로 모델에 건넨다.
//  - 답변 문장: 지시문으로 출처 표현을 막고, 서버가 다시 검사한다. 출처 표현이 있으면 한 번 다시 쓰게 하고,
//    그래도 남으면 그 문장을 뺀다.
//  - 화면: 답변이 기댄 지식이 철회·수정·삭제되거나 AI 참고에서 빠지면 '숨김' 안내를 띄우지 않는다.
//    다음에 대화를 열 때 같은 질문으로 답변을 조용히 다시 쓴다(사용자에겐 평범한 '답변 작성 중'으로 보임).
//    삭제된 지식이 들어간 답변 본문은 다시 쓰기 전에 이미 DB 에서 지워진다(notes.ts purgeAdviceForNote).
//  - 모델에게 "그 내용은 쓰지 마"라고 말하지 않는다. 대신 빠진 지식이 넘어갔던 이전 턴의 답변은 이어지는 대화에
//    넣지 않는다(질문만 넣음). 모델이 반영 사실을 밝히지 않았더라도 그 내용이 다시 흘러들지 않게 하기 위해서다.
//  - 대화는 묻는 사람에게만 보인다.
import { requireMembership } from "./access.ts";
import { callAi, errorCode, finalize, markStale, recordInputs, recordUsage } from "./advice.ts";
import { aiUnavailable } from "./ai/providers.ts";
import type { AiProvider, CandidateForAi, ChatInput, ProjectContext } from "./ai/types.ts";
import { dropLeakySentences, InvalidAiOutput, sourceLeaks, validateChatOutput, type CitableUse } from "./ai/validate-output.ts";
import { audit, getPool } from "./db.ts";
import { notFound } from "./errors.ts";
import { findCandidates, type Candidate } from "./search.ts";
import { clip, text, uuid } from "./validate.ts";

/** 모델에 건넬 팀 지식 최대 수. 공유 지식이 이 이하인 팀은 키워드가 안 겹쳐도 전부 건넨다 */
const MAX_KNOWLEDGE = 30;
/** 이어서 건넬 이전 대화 턴 수 */
const HISTORY_TURNS = 6;
const MAX_QUESTION = 2000;
/** 회의록 하나를 모델에 건넬 때의 최대 길이 */
const MAX_MEETING_CHARS = 6000;
/** 한 번 열 때 다시 쓸 최대 답변 수 (나머지는 다음 요청에서) */
const REFRESH_BATCH = 3;

const RETRY_NOTE =
  "앞선 답변 초안이 출처 표시 규칙을 어겼다. 출처는 실제로 반영한 '팀 공유 메모'와 '회의록'만 밝힐 수 있다. private 지식이나 반영하지 않은 지식을 메모·회의·기록에서 나온 것처럼 말하지 말고, 비공개 정보가 있다는 사실도 드러내지 말고 다시 답하라.";
/** 대화 기억: 최근 대화 밖으로 밀려난 턴이 이만큼 쌓이면 요약에 접어 넣는다 (기억이 아직 없으면 1턴부터) */
const MEMORY_FOLD_AT = 3;
/** 기억을 처음부터 다시 만들 때 접어 넣을 최대 턴 수 */
const MEMORY_REBUILD_TURNS = 40;
const MAX_MEMORY = 4000;

type KnowledgeKind = "memo" | "meeting" | "private";
const kindOf = (c: Candidate): KnowledgeKind => (c.origin === "meeting" ? "meeting" : c.aiOnly ? "private" : "memo");

/** 이번 답변이 반영했다고 밝힌 지식 중 출처를 밝혀도 되는 종류 */
function citable(used: string[], kinds: ReadonlyMap<string, KnowledgeKind>): CitableUse {
  return { memo: used.some((r) => kinds.get(r) === "memo"), meeting: used.some((r) => kinds.get(r) === "meeting") };
}

type TaskRow = { id: string; team_id: string; title: string; purpose: string; audience: string; constraints: string; version: number };

const projectOf = (t: TaskRow): ProjectContext => ({ title: t.title, purpose: t.purpose, audience: t.audience, constraints: t.constraints });

/**
 * target 이전(또는 전체)의 최근 대화. 다시 써야 하는 턴은 빼고, 넘어갔던 지식 중 하나라도 지금 쓸 수 없게 된 턴은
 * 답변을 빼고 질문만 넣는다.
 */
async function historyFor(taskId: string, userId: string, before: string | null) {
  const r = await getPool().query(
    `select * from (
       select r.question, r.created_at, r.created_at::text as at_text, i.body,
              coalesce((select bool_and(coalesce(n.current_version_id = v.id and n.share_state = 'shared' and n.allow_external_ai, false))
                        from unnest(r.input_version_ids) e(id)
                        left join note_versions v on v.id = e.id
                        left join notes n on n.id = v.note_id), true) as inputs_live
       from advice_requests r
       join advice_items i on i.request_id = r.id and i.section = 'answer' and not i.purged
       where r.task_id = $1 and r.requester_id = $2 and r.kind = 'chat' and r.status = 'ok'
         and ($3::timestamptz is null or r.created_at < $3)
       order by r.created_at desc limit $4) x
     order by created_at asc`,
    [taskId, userId, before, HISTORY_TURNS],
  );
  const turns: ChatInput["history"] = r.rows.map((x) => ({ question: x.question as string, answer: x.inputs_live ? clip(x.body as string, 1500) : null }));
  // 최근 대화가 꽉 찼으면 그보다 오래된 대화는 대화 기억(요약)으로 넘긴다
  // 시각은 DB 문자열 그대로 넘긴다 (JS Date 는 마이크로초를 잃어 경계의 턴이 겹치거나 빠진다)
  const cutoff = r.rows.length === HISTORY_TURNS ? (r.rows[0].at_text as string) : null;
  return { turns, cutoff };
}

/**
 * 모델 호출 → 출력 검증 → 출처 표현 검사.
 * 공개 메모·회의록을 실제로 반영했다면 그 출처 표현은 허용하고, 그 밖의 출처 표현(반영하지 않은 지식, 'AI만 참고' 정보,
 * 비공개 정보의 존재)은 1회 다시 쓰게 한 뒤 그래도 남으면 그 문장을 뺀다.
 */
async function generate(provider: AiProvider, input: ChatInput, kinds: ReadonlyMap<string, KnowledgeKind>) {
  const validRefs = new Set(kinds.keys());
  let out = validateChatOutput(await callAi(() => provider.chat(input)), validRefs);
  if (sourceLeaks(out.answer, input.question, citable(out.used, kinds)).length) {
    const retry = validateChatOutput(await callAi(() => provider.chat({ ...input, retryNote: RETRY_NOTE })), validRefs);
    const allowed = citable(retry.used, kinds);
    out = sourceLeaks(retry.answer, input.question, allowed).length
      ? { ...retry, answer: dropLeakySentences(retry.answer, input.question, allowed) }
      : retry;
    if (!out.answer) throw new InvalidAiOutput("answer empty after removing source mentions");
  }
  return out;
}

const LIVE_INPUTS = `coalesce((select bool_and(coalesce(n.current_version_id = v.id and n.share_state = 'shared' and n.allow_external_ai, false))
                     from unnest(r.input_version_ids) e(id)
                     left join note_versions v on v.id = e.id
                     left join notes n on n.id = v.note_id), true)`;

/**
 * 사용자별 대화 기억: 최근 대화(history) 밖으로 밀려난 턴을 요약해 둔다(본인만 씀).
 * - 요약에 접어 넣은 턴이 받았던 지식이 하나라도 지금 쓸 수 없으면(철회·수정·삭제·AI 참고 해제) 요약을 버리고 다시 만든다.
 *   그 지식이 넘어간 턴은 답변 없이 질문만 접어 넣는다. 지식을 지우면 notes.ts 가 해당 요약을 바로 지운다.
 * - 요약에 실패해도 대화는 막지 않는다(있던 요약을 그대로 쓰거나 없이 답함).
 */
async function memoryFor(task: TaskRow, userId: string, cutoff: string | null, provider: AiProvider): Promise<string | null> {
  if (!cutoff) return null; // 최근 대화보다 오래된 대화가 없음
  const db = getPool();
  const m = await db.query(
    `select m.summary, m.covered_until::text as covered_until,
            coalesce((select bool_and(coalesce(n.current_version_id = v.id and n.share_state = 'shared' and n.allow_external_ai, false))
                      from unnest(m.input_version_ids) e(id)
                      left join note_versions v on v.id = e.id
                      left join notes n on n.id = v.note_id), true) as live,
            m.input_version_ids
     from chat_memories m where m.task_id = $1 and m.user_id = $2`,
    [task.id, userId],
  );
  let mem = m.rows[0] as { summary: string; covered_until: string; live: boolean; input_version_ids: string[] } | undefined;
  if (mem && !mem.live) {
    await db.query("delete from chat_memories where task_id = $1 and user_id = $2", [task.id, userId]);
    mem = undefined;
  }
  const older = await db.query(
    `select * from (
       select r.question, r.created_at, r.created_at::text as at_text, i.body, r.input_version_ids, ${LIVE_INPUTS} as inputs_live
       from advice_requests r
       join advice_items i on i.request_id = r.id and i.section = 'answer' and not i.purged
       where r.task_id = $1 and r.requester_id = $2 and r.kind = 'chat' and r.status = 'ok'
         and r.created_at < $3::timestamptz and ($4::timestamptz is null or r.created_at > $4::timestamptz)
       order by r.created_at desc limit $5) x
     order by created_at asc`,
    [task.id, userId, cutoff, mem?.covered_until ?? null, MEMORY_REBUILD_TURNS],
  );
  if (older.rowCount! < (mem ? MEMORY_FOLD_AT : 1)) return mem?.summary ?? null;
  try {
    const raw = await callAi(() =>
      provider.recap({
        previous: mem?.summary ?? null,
        turns: older.rows.map((t) => ({ question: clip(t.question, 600), answer: t.inputs_live ? clip(t.body, 800) : null })),
      }),
    );
    const summary = raw && typeof raw === "object" ? (raw as Record<string, unknown>).summary : undefined;
    if (typeof summary !== "string" || !summary.trim()) return mem?.summary ?? null;
    const ids = [...new Set([...(mem?.input_version_ids ?? []), ...older.rows.flatMap((t) => t.input_version_ids as string[])])];
    const last = older.rows[older.rows.length - 1].at_text as string;
    await db.query(
      `insert into chat_memories (task_id, user_id, summary, covered_until, input_version_ids, updated_at)
       values ($1, $2, $3, $4::timestamptz, $5, now())
       on conflict (task_id, user_id) do update set summary = excluded.summary, covered_until = excluded.covered_until,
         input_version_ids = excluded.input_version_ids, updated_at = now()`,
      [task.id, userId, summary.trim().slice(0, MAX_MEMORY), last, ids],
    );
    return summary.trim().slice(0, MAX_MEMORY);
  } catch (err) {
    console.error("chat memory failed", (err as Error)?.name);
    return mem?.summary ?? null;
  }
}

/** 요청 하나의 답변을 만들어 저장한다. 요청은 'pending' 상태여야 한다(새 질문 또는 다시 쓰기). */
async function answer(userId: string, task: TaskRow, requestId: string, question: string, createdAt: string | null, provider: AiProvider) {
  const db = getPool();
  provider.drainUsage?.();
  try {
    const project = projectOf(task);
    const { turns: history, cutoff } = await historyFor(task.id, userId, createdAt);
    // 대화 기억은 새 질문에만 쓴다(예전 답변을 다시 쓸 때는 그 시점 이후의 대화가 섞이지 않게)
    const memory = createdAt ? null : await memoryFor(task, userId, cutoff, provider);
    // 검색어는 앞에서부터 정해진 개수만 쓰므로(keywords.ts) 현재 질문을 맨 앞에, 그다음 최근 질문, 프로젝트 정보 순으로 둔다.
    // 프로젝트 설명이나 이전 질문이 길어도 지금 묻는 말의 검색어가 잘려 나가지 않게 하기 위해서다.
    const query = [question, ...history.map((h) => h.question).reverse(), project.title, project.purpose, project.audience, project.constraints]
      .filter(Boolean)
      .join("\n");
    const found = await findCandidates(task.team_id, query, { requireExternalAi: true, limit: MAX_KNOWLEDGE, includeAllIfAtMost: MAX_KNOWLEDGE, includeAiOnly: true });
    // 다시 쓰기라면 이전 입력 기록을 이번 입력으로 바꾼다 (지식이 없으면 비움)
    const live = found.length
      ? await recordInputs(requestId, task.team_id, found)
      : (await db.query("update advice_requests set input_version_ids = '{}', candidate_count = 0 where id = $1", [requestId]), []);
    const byRef = new Map<string, Candidate>(live.map((c, i) => [`N${i + 1}`, c]));
    const knowledge: CandidateForAi[] = [...byRef].map(([ref, c]) => ({
      ref,
      text: c.origin === "meeting" ? clip(c.rawText, MAX_MEETING_CHARS) : c.rawText,
      summary: c.summary,
      conditions: c.conditions,
      meeting: c.origin === "meeting" ? { title: c.title ?? "", date: c.meetingDate ?? "" } : null,
      aiOnly: c.aiOnly,
    }));

    const kinds = new Map([...byRef].map(([ref, c]) => [ref, kindOf(c)] as const));
    const me = await db.query("select display_name from users where id = $1", [userId]);
    const askerName = (me.rows[0]?.display_name as string | undefined) ?? null;
    const out = await generate(provider, { project, askerName, memory, history, knowledge, question }, kinds);
    const usedIds = out.used.map((r) => byRef.get(r)!.versionId);
    // 확정 직전 재확인은 실제로 반영한 지식만 대상으로 한다
    await finalize(requestId, userId, task.team_id, task.id, task.version, {
      items: [{ section: "answer", body: out.answer, evidence: usedIds.map((versionId) => ({ versionId, quote: null })), action: null }],
      dropped: out.dropped,
      emptyReason: null,
      inputIds: usedIds,
    });
  } catch (err) {
    const code = errorCode(err);
    console.error("chat failed", code, (err as Error)?.name, code === "ai_error" ? String((err as Error)?.message).slice(0, 200) : "");
    await db.query(
      "update advice_requests set status = 'failed', error = $2, finished_at = now() where id = $1 and status = 'pending'",
      [requestId, code],
    );
  }
  await recordUsage(requestId, provider);
}

async function loadTask(userId: string, taskId: string): Promise<TaskRow> {
  const db = getPool();
  const t = await db.query("select id, team_id, title, purpose, audience, constraints, version from tasks where id = $1", [taskId]);
  if (!t.rowCount) throw notFound();
  await requireMembership(db, userId, t.rows[0].team_id);
  return t.rows[0] as TaskRow;
}

export async function askInProject(
  userId: string,
  taskId: string,
  input: { question: unknown; clientRequestId?: unknown },
  provider: AiProvider,
) {
  const question = text(input.question, "질문", { min: 1, max: MAX_QUESTION });
  const clientRequestId =
    input.clientRequestId === undefined || input.clientRequestId === null ? null : uuid(input.clientRequestId, "clientRequestId");
  const task = await loadTask(userId, taskId);
  if (!provider.isAi) throw aiUnavailable();

  const db = getPool();
  const ins = await db.query(
    `insert into advice_requests (team_id, task_id, requester_id, task_version, context, question, provider, client_request_id, kind, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'chat', now())
     on conflict (requester_id, client_request_id) where client_request_id is not null do nothing
     returning id`,
    [task.team_id, task.id, userId, task.version, JSON.stringify({ ...projectOf(task), question }), question, provider.name, clientRequestId],
  );
  if (!ins.rowCount) {
    const ex = await db.query("select id from advice_requests where requester_id = $1 and client_request_id = $2", [userId, clientRequestId]);
    return getChatTurn(userId, ex.rows[0].id);
  }
  const requestId = ins.rows[0].id as string;
  await audit(db, userId, "chat.ask", requestId, { provider: provider.name });
  await answer(userId, task, requestId, question, null, provider);
  return getChatTurn(userId, requestId);
}

export type ChatTurn = {
  id: string;
  question: string;
  /** stale 이면 'pending' 으로 보인다 (화면은 '답변 작성 중') */
  status: string;
  error: string | null;
  createdAt: string;
  answer: string | null;
  /** 기댄 지식이 바뀌어 다시 써야 함. 화면에는 사유를 드러내지 않는다 */
  stale: boolean;
  /** 답변에 반영된 팀원 공개 지식(공유 메모·회의록). 'AI만 참고' 메모는 넣지 않는다 */
  sources: ChatSource[];
};

export type ChatSource =
  | { kind: "memo"; noteId: string; text: string }
  | { kind: "meeting"; noteId: string; title: string; date: string; text: string };

const TURN_SQL = `
  select r.id, r.question, r.status, r.error, r.created_at,
         i.body, coalesce(i.purged, false) as purged,
         coalesce((select bool_and(coalesce(n.current_version_id = v.id and n.share_state = 'shared' and n.allow_external_ai, false))
                   from unnest(i.evidence_version_ids) e(id)
                   left join note_versions v on v.id = e.id
                   left join notes n on n.id = v.note_id), true) as evidence_live,
         coalesce((select json_agg(json_build_object('kind', case when n.origin = 'meeting' then 'meeting' else 'memo' end,
                                                     'noteId', n.id, 'title', n.title, 'date', n.meeting_date::text, 'text', v.raw_text)
                                   order by n.origin, n.updated_at desc)
                   from unnest(i.evidence_version_ids) e(id)
                   join note_versions v on v.id = e.id
                   join notes n on n.id = v.note_id
                   where n.current_version_id = v.id and n.share_state = 'shared' and n.visibility = 'team'), '[]'::json) as sources
  from advice_requests r
  left join advice_items i on i.request_id = r.id and i.section = 'answer'`;

function toTurn(row: Record<string, any>): ChatTurn {
  const stale = row.status === "invalidated" || row.purged || (row.status === "ok" && !row.evidence_live);
  return {
    id: row.id,
    question: row.question,
    status: stale ? "pending" : row.status,
    error: stale ? null : (row.error ?? null),
    createdAt: row.created_at,
    answer: row.status === "ok" && !stale ? (row.body as string) : null,
    stale,
    sources: row.status === "ok" && !stale
      ? (row.sources as Record<string, string>[]).map((x) =>
          x.kind === "meeting"
            ? { kind: "meeting" as const, noteId: x.noteId!, title: x.title ?? "", date: x.date ?? "", text: x.text! }
            : { kind: "memo" as const, noteId: x.noteId!, text: x.text! })
      : [],
  };
}

export async function getChatTurn(userId: string, requestId: string): Promise<ChatTurn> {
  const db = getPool();
  await markStale(db, "id = $1", [requestId]);
  const owner = await db.query("select team_id, requester_id from advice_requests where id = $1 and kind = 'chat'", [requestId]);
  if (!owner.rowCount) throw notFound();
  await requireMembership(db, userId, owner.rows[0].team_id);
  if (owner.rows[0].requester_id !== userId) throw notFound(); // 대화는 묻는 사람에게만 보인다
  const r = await db.query(`${TURN_SQL} where r.id = $1`, [requestId]);
  return toTurn(r.rows[0]);
}

/** 이 프로젝트에서 내가 나눈 대화 (오래된 것부터) */
export async function listChat(userId: string, taskId: string) {
  const task = await loadTask(userId, taskId);
  const db = getPool();
  await markStale(db, "task_id = $1 and requester_id = $2", [task.id, userId]);
  const r = await db.query(
    `select * from (${TURN_SQL}
       where r.task_id = $1 and r.requester_id = $2 and r.kind = 'chat'
       order by r.created_at desc limit 100) x
     order by created_at asc`,
    [task.id, userId],
  );
  return r.rows.map(toTurn);
}

/**
 * 기댄 지식이 바뀐 답변을 조용히 다시 쓴다 (오래된 것부터 최대 REFRESH_BATCH 개).
 * 같은 답변을 두 곳에서 동시에 다시 쓰지 않도록 상태를 원자적으로 'pending' 으로 바꾼 쪽만 진행한다.
 */
export async function refreshStale(userId: string, taskId: string, provider: AiProvider) {
  const task = await loadTask(userId, taskId);
  const stale = (await listChat(userId, taskId)).filter((t) => t.stale).slice(0, REFRESH_BATCH);
  if (stale.length && !provider.isAi) throw aiUnavailable();
  const db = getPool();
  for (const t of stale) {
    const claim = await db.query(
      `update advice_requests set status = 'pending', error = null, finished_at = null, started_at = now(), task_version = $3
       where id = $1 and requester_id = $2 and kind = 'chat' and status in ('ok', 'invalidated')
       returning created_at::text as at_text`,
      [t.id, userId, task.version],
    );
    if (!claim.rowCount) continue;
    // 예전 답변(본문·기록)을 먼저 지운다: 다시 쓰기에 실패해도 예전 내용이 되살아나지 않게
    await db.query("delete from advice_items where request_id = $1", [t.id]);
    await audit(db, userId, "chat.refresh", t.id, { provider: provider.name });
    await answer(userId, task, t.id, t.question, claim.rows[0].at_text as string, provider);
  }
  return listChat(userId, taskId);
}
