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
import { dropLeakySentences, InvalidAiOutput, sourceLeaks, validateChatOutput } from "./ai/validate-output.ts";
import { audit, getPool } from "./db.ts";
import { notFound } from "./errors.ts";
import { findCandidates, type Candidate } from "./search.ts";
import { clip, text, uuid } from "./validate.ts";

/** 모델에 건넬 팀 지식 최대 수. 공유 지식이 이 이하인 팀은 키워드가 안 겹쳐도 전부 건넨다 */
const MAX_KNOWLEDGE = 30;
/** 이어서 건넬 이전 대화 턴 수 */
const HISTORY_TURNS = 6;
const MAX_QUESTION = 2000;
/** 한 번 열 때 다시 쓸 최대 답변 수 (나머지는 다음 요청에서) */
const REFRESH_BATCH = 3;

const RETRY_NOTE =
  "앞선 답변 초안에 정보의 출처를 언급하는 표현이 있었다. 출처·메모·기록·팀원·공유 같은 말 없이, 네가 원래 아는 맥락처럼 다시 답하라.";

type TaskRow = { id: string; team_id: string; title: string; purpose: string; audience: string; constraints: string; version: number };

const projectOf = (t: TaskRow): ProjectContext => ({ title: t.title, purpose: t.purpose, audience: t.audience, constraints: t.constraints });

/**
 * target 이전(또는 전체)의 최근 대화. 다시 써야 하는 턴은 빼고, 넘어갔던 지식 중 하나라도 지금 쓸 수 없게 된 턴은
 * 답변을 빼고 질문만 넣는다.
 */
async function historyFor(taskId: string, userId: string, before: Date | null): Promise<ChatInput["history"]> {
  const r = await getPool().query(
    `select * from (
       select r.question, r.created_at, i.body,
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
  return r.rows.map((x) => ({ question: x.question as string, answer: x.inputs_live ? clip(x.body as string, 1500) : null }));
}

/** 모델 호출 → 출력 검증 → 출처 표현 검사(1회 다시 쓰기, 그래도 남으면 그 문장 제거) */
async function generate(provider: AiProvider, input: ChatInput, validRefs: ReadonlySet<string>) {
  let out = validateChatOutput(await callAi(() => provider.chat(input)), validRefs);
  if (sourceLeaks(out.answer, input.question).length) {
    const retry = validateChatOutput(await callAi(() => provider.chat({ ...input, retryNote: RETRY_NOTE })), validRefs);
    out = sourceLeaks(retry.answer, input.question).length
      ? { ...retry, answer: dropLeakySentences(retry.answer, input.question) }
      : retry;
    if (!out.answer) throw new InvalidAiOutput("answer empty after removing source mentions");
  }
  return out;
}

/** 요청 하나의 답변을 만들어 저장한다. 요청은 'pending' 상태여야 한다(새 질문 또는 다시 쓰기). */
async function answer(userId: string, task: TaskRow, requestId: string, question: string, createdAt: Date | null, provider: AiProvider) {
  const db = getPool();
  provider.drainUsage?.();
  try {
    const project = projectOf(task);
    const history = await historyFor(task.id, userId, createdAt);
    const query = [project.title, project.purpose, project.audience, project.constraints, ...history.map((h) => h.question), question]
      .filter(Boolean)
      .join("\n");
    const found = await findCandidates(task.team_id, query, { requireExternalAi: true, limit: MAX_KNOWLEDGE, includeAllIfAtMost: MAX_KNOWLEDGE });
    // 다시 쓰기라면 이전 입력 기록을 이번 입력으로 바꾼다 (지식이 없으면 비움)
    const live = found.length
      ? await recordInputs(requestId, task.team_id, found)
      : (await db.query("update advice_requests set input_version_ids = '{}', candidate_count = 0 where id = $1", [requestId]), []);
    const byRef = new Map<string, Candidate>(live.map((c, i) => [`N${i + 1}`, c]));
    const knowledge: CandidateForAi[] = [...byRef].map(([ref, c]) => ({ ref, text: c.rawText, summary: c.summary, conditions: c.conditions }));

    const out = await generate(provider, { project, history, knowledge, question }, new Set(byRef.keys()));
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
};

const TURN_SQL = `
  select r.id, r.question, r.status, r.error, r.created_at,
         i.body, coalesce(i.purged, false) as purged,
         coalesce((select bool_and(coalesce(n.current_version_id = v.id and n.share_state = 'shared' and n.allow_external_ai, false))
                   from unnest(i.evidence_version_ids) e(id)
                   left join note_versions v on v.id = e.id
                   left join notes n on n.id = v.note_id), true) as evidence_live
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
       returning created_at`,
      [t.id, userId, task.version],
    );
    if (!claim.rowCount) continue;
    // 예전 답변(본문·기록)을 먼저 지운다: 다시 쓰기에 실패해도 예전 내용이 되살아나지 않게
    await db.query("delete from advice_items where request_id = $1", [t.id]);
    await audit(db, userId, "chat.refresh", t.id, { provider: provider.name });
    await answer(userId, task, t.id, t.question, claim.rows[0].created_at as Date, provider);
  }
  return listChat(userId, taskId);
}
