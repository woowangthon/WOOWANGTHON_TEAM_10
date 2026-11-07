// 프로젝트 대화: 일반 AI 와 대화하듯 묻고 답한다.
//
//  - 질문에는 항상 답한다. 팀 공유 메모가 없거나 관련이 없어도 일반 지식으로 답한다.
//  - 권한·상태 필터를 통과한 팀 공유 메모(AI 처리 허용분)만 모델에 건넨다. 다른 팀·초안·철회·AI 미허용 메모는 가지 않는다.
//  - 답변에는 메모를 참고했다는 표시를 하지 않는다. 대신 모델이 실제로 반영했다고 밝힌 메모를
//    advice_items.evidence_version_ids 에 기록해 두고, 그 메모가 철회·수정되면 답변을 숨기고 삭제되면 본문을 지운다.
//  - 대화는 묻는 사람에게만 보인다. 같은 프로젝트의 이전 대화(최근 몇 턴)를 이어서 모델에 준다.
import { requireMembership } from "./access.ts";
import { callAi, errorCode, finalize, markStale, recordInputs, recordUsage } from "./advice.ts";
import { aiUnavailable } from "./ai/providers.ts";
import type { AiProvider, CandidateForAi, ProjectContext } from "./ai/types.ts";
import { validateChatOutput } from "./ai/validate-output.ts";
import { audit, getPool } from "./db.ts";
import { notFound } from "./errors.ts";
import { findCandidates, type Candidate } from "./search.ts";
import { clip, text, uuid } from "./validate.ts";

/** 모델에 건넬 팀 지식 최대 수. 공유 메모가 이 이하인 팀은 키워드가 안 겹쳐도 전부 건넨다 */
const MAX_KNOWLEDGE = 30;
/** 이어서 건넬 이전 대화 턴 수 */
const HISTORY_TURNS = 6;
const MAX_QUESTION = 2000;

type TurnRow = { question: string; answer: string };

/** 같은 프로젝트에서 내가 나눈 최근 대화 중, 지금도 보여줄 수 있는 것만 (숨김·삭제된 답변은 빼고) */
async function recentHistory(taskId: string, userId: string): Promise<TurnRow[]> {
  const turns = await listChat(userId, taskId, { limit: HISTORY_TURNS, skipAccessCheck: true });
  return turns.filter((t) => t.status === "ok" && t.answer).map((t) => ({ question: t.question, answer: clip(t.answer!, 1500) }));
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
  const db = getPool();
  const t = await db.query("select * from tasks where id = $1", [taskId]);
  const task = t.rows[0];
  if (!task) throw notFound();
  await requireMembership(db, userId, task.team_id);
  if (!provider.isAi) throw aiUnavailable();

  const project: ProjectContext = { title: task.title, purpose: task.purpose, audience: task.audience, constraints: task.constraints };
  const ins = await db.query(
    `insert into advice_requests (team_id, task_id, requester_id, task_version, context, question, provider, client_request_id, kind)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'chat')
     on conflict (requester_id, client_request_id) where client_request_id is not null do nothing
     returning id`,
    [task.team_id, task.id, userId, task.version, JSON.stringify({ ...project, question }), question, provider.name, clientRequestId],
  );
  if (!ins.rowCount) {
    const ex = await db.query("select id from advice_requests where requester_id = $1 and client_request_id = $2", [userId, clientRequestId]);
    return getChatTurn(userId, ex.rows[0].id);
  }
  const requestId = ins.rows[0].id as string;
  await audit(db, userId, "chat.ask", requestId, { provider: provider.name });
  provider.drainUsage?.();

  try {
    const history = await recentHistory(task.id, userId);
    const query = [project.title, project.purpose, project.audience, project.constraints, ...history.map((h) => h.question), question]
      .filter(Boolean)
      .join("\n");
    const found = await findCandidates(task.team_id, query, {
      requireExternalAi: true,
      limit: MAX_KNOWLEDGE,
      includeAllIfAtMost: MAX_KNOWLEDGE,
    });
    const live = found.length ? await recordInputs(requestId, task.team_id, found) : [];
    const byRef = new Map<string, Candidate>(live.map((c, i) => [`N${i + 1}`, c]));
    const knowledge: CandidateForAi[] = [...byRef].map(([ref, c]) => ({ ref, text: c.rawText, summary: c.summary, conditions: c.conditions }));

    const raw = await callAi(() => provider.chat({ project, history, knowledge, question }));
    const out = validateChatOutput(raw, new Set(byRef.keys()));
    const usedIds = out.used.map((r) => byRef.get(r)!.versionId);
    // 확정 직전 재확인은 실제로 반영한 메모만 대상으로 한다 (건네기만 하고 쓰지 않은 메모의 철회로 답변을 버리지 않음)
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
  return getChatTurn(userId, requestId);
}

export type ChatTurn = {
  id: string;
  question: string;
  status: string;
  error: string | null;
  createdAt: string;
  /** 숨김·삭제·실패면 null */
  answer: string | null;
  /** 답변에 반영된 정보가 철회·수정·삭제되어 숨김 */
  hidden: boolean;
};

const TURN_SQL = `
  select r.id, r.question, r.status, r.error, r.created_at,
         i.body, coalesce(i.purged, false) as purged,
         coalesce((select bool_and(coalesce(n.current_version_id = v.id and n.share_state = 'shared', false))
                   from unnest(i.evidence_version_ids) e(id)
                   left join note_versions v on v.id = e.id
                   left join notes n on n.id = v.note_id), true) as evidence_live
  from advice_requests r
  left join advice_items i on i.request_id = r.id and i.section = 'answer'`;

function toTurn(row: Record<string, any>): ChatTurn {
  const hidden = row.status === "invalidated" || row.purged || (row.status === "ok" && !row.evidence_live);
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    error: row.error ?? null,
    createdAt: row.created_at,
    answer: row.status === "ok" && !hidden ? (row.body as string) : null,
    hidden,
  };
}

export async function getChatTurn(userId: string, requestId: string): Promise<ChatTurn> {
  const db = getPool();
  await markStale(db, "id = $1", [requestId]);
  const r = await db.query(`${TURN_SQL} where r.id = $1 and r.kind = 'chat'`, [requestId]);
  const row = r.rows[0];
  if (!row) throw notFound();
  const owner = await db.query("select team_id, requester_id from advice_requests where id = $1", [requestId]);
  await requireMembership(db, userId, owner.rows[0].team_id);
  if (owner.rows[0].requester_id !== userId) throw notFound(); // 대화는 묻는 사람에게만 보인다
  return toTurn(row);
}

/** 이 프로젝트에서 내가 나눈 대화 (오래된 것부터) */
export async function listChat(userId: string, taskId: string, opts: { limit?: number; skipAccessCheck?: boolean } = {}) {
  const db = getPool();
  if (!opts.skipAccessCheck) {
    const t = await db.query("select team_id from tasks where id = $1", [taskId]);
    if (!t.rowCount) throw notFound();
    await requireMembership(db, userId, t.rows[0].team_id);
    await markStale(db, "task_id = $1 and requester_id = $2", [taskId, userId]);
  }
  const r = await db.query(
    `select * from (${TURN_SQL}
       where r.task_id = $1 and r.requester_id = $2 and r.kind = 'chat'
       order by r.created_at desc limit $3) x
     order by created_at asc`,
    [taskId, userId, Math.min(Math.max(opts.limit ?? 100, 1), 200)],
  );
  return r.rows.map(toTurn);
}
