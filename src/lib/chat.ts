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
import { MAX_MEETING } from "./meetings.ts";
import { findCandidates, type Candidate } from "./search.ts";
import { clip, text, uuid } from "./validate.ts";

/** 모델에 건넬 팀 지식 최대 수. 공유 지식이 이 이하인 팀은 키워드가 안 겹쳐도 전부 건넨다 */
const MAX_KNOWLEDGE = 30;
/** 이어서 건넬 이전 대화 턴 수 */
const HISTORY_TURNS = 6;
const MAX_QUESTION = 2000;
/** 회의록 하나를 모델에 건넬 때의 최대 길이. 입력 한도(meetings.ts MAX_MEETING)와 같게 둬서 긴 회의록 끝의 결정이 잘리지 않게 한다 */
const MAX_MEETING_CHARS = MAX_MEETING;
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
       select r.question, r.created_at, r.created_at::text as at_text, i.body, r.input_version_ids,
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
  // 답변을 그대로 넘기는 턴은 그 답변이 받았던 지식도 이번 답변에 함께 흘러든다(모델이 이전 답변의 내용을 반복할 수 있음).
  // 그래서 그 지식들을 이번 요청의 입력으로 물려받아 기록한다. 원래 메모를 지우거나 범위를 좁히면 파생 답변까지 함께 다시 쓰인다.
  const inherited = r.rows.filter((x) => x.inputs_live).flatMap((x) => x.input_version_ids as string[]);
  // 최근 대화가 꽉 찼으면 그보다 오래된 대화는 대화 기억(요약)으로 넘긴다
  // 시각은 DB 문자열 그대로 넘긴다 (JS Date 는 마이크로초를 잃어 경계의 턴이 겹치거나 빠진다)
  const cutoff = r.rows.length === HISTORY_TURNS ? (r.rows[0].at_text as string) : null;
  return { turns, cutoff, inherited };
}

/**
 * 모델 호출 → 출력 검증 → 출처 표현 검사.
 * 공개 메모·회의록을 실제로 반영했다면 그 출처 표현은 허용하고, 그 밖의 출처 표현(반영하지 않은 지식, 'AI만 참고' 정보,
 * 비공개 정보의 존재)은 1회 다시 쓰게 한 뒤 그래도 남으면 그 문장을 뺀다.
 */
async function generate(provider: AiProvider, input: ChatInput, kinds: ReadonlyMap<string, KnowledgeKind>) {
  const validRefs = new Set(kinds.keys());
  let out = validateChatOutput(await callAi((signal) => provider.chat(input, { signal })), validRefs);
  if (sourceLeaks(out.answer, input.question, citable(out.used, kinds)).length) {
    const retry = validateChatOutput(await callAi((signal) => provider.chat({ ...input, retryNote: RETRY_NOTE }, { signal })), validRefs);
    const allowed = citable(retry.used, kinds);
    out = sourceLeaks(retry.answer, input.question, allowed).length
      ? { ...retry, answer: dropLeakySentences(retry.answer, input.question, allowed) }
      : retry;
    if (!out.answer) throw new InvalidAiOutput("answer empty after removing source mentions");
  }
  return out;
}

/** 오늘 날짜와 요일 (한국 시간). 예: "2026-11-09 (월)" */
export function todayKst(now = new Date()): string {
  const d = new Date(now.getTime() + 9 * 3600_000);
  return `${d.toISOString().slice(0, 10)} (${"일월화수목금토"[d.getUTCDay()]})`;
}

async function withCurrentVisibility(cands: Candidate[]): Promise<Candidate[]> {
  const r = await getPool().query("select id, visibility from notes where id = any($1::uuid[])", [cands.map((c) => c.noteId)]);
  const vis = new Map(r.rows.map((x) => [x.id as string, x.visibility as string]));
  return cands.map((c) => ({ ...c, aiOnly: vis.get(c.noteId) === "ai_only" }));
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
type Memory = { summary: string; ids: string[] } | null;

async function memoryFor(task: TaskRow, userId: string, cutoff: string | null, provider: AiProvider): Promise<Memory> {
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
  const kept: Memory = mem ? { summary: mem.summary, ids: mem.input_version_ids } : null;
  if (older.rowCount! < (mem ? MEMORY_FOLD_AT : 1)) return kept;
  try {
    const raw = await callAi((signal) =>
      provider.recap(
        {
          previous: mem?.summary ?? null,
          turns: older.rows.map((t) => ({ question: clip(t.question, 600), answer: t.inputs_live ? clip(t.body, 800) : null })),
        },
        { signal },
      ),
    );
    const summary = raw && typeof raw === "object" ? (raw as Record<string, unknown>).summary : undefined;
    if (typeof summary !== "string" || !summary.trim()) return kept;
    // 답변까지 접어 넣은 턴의 지식만 기록한다. 질문만 넣은 턴(지식이 바뀐 턴)의 지식은 요약에 들어가지 않았다.
    // 그것까지 기록하면 요약이 만들자마자 '무효'가 되어 질문마다 버려지고, 요약을 물려받은 새 답변도 대화에서 빠진다.
    const ids = [...new Set([...(mem?.input_version_ids ?? []), ...older.rows.filter((t) => t.inputs_live).flatMap((t) => t.input_version_ids as string[])])];
    const last = older.rows[older.rows.length - 1].at_text as string;
    await db.query(
      `insert into chat_memories (task_id, user_id, summary, covered_until, input_version_ids, updated_at)
       values ($1, $2, $3, $4::timestamptz, $5, now())
       on conflict (task_id, user_id) do update set summary = excluded.summary, covered_until = excluded.covered_until,
         input_version_ids = excluded.input_version_ids, updated_at = now()`,
      [task.id, userId, summary.trim().slice(0, MAX_MEMORY), last, ids],
    );
    return { summary: summary.trim().slice(0, MAX_MEMORY), ids };
  } catch (err) {
    console.error("chat memory failed", (err as Error)?.name);
    return kept;
  }
}

/** 요청 하나의 답변을 만들어 저장한다. 요청은 'pending' 상태여야 한다(새 질문 또는 다시 쓰기). */
async function answer(userId: string, task: TaskRow, requestId: string, question: string, createdAt: string | null, provider: AiProvider) {
  const db = getPool();
  provider.drainUsage?.();
  try {
    const project = projectOf(task);
    const { turns: history, cutoff, inherited } = await historyFor(task.id, userId, createdAt);
    // 대화 기억은 새 질문에만 쓴다(예전 답변을 다시 쓸 때는 그 시점 이후의 대화가 섞이지 않게)
    const memory = createdAt ? null : await memoryFor(task, userId, cutoff, provider);
    // 검색어는 앞에서부터 정해진 개수만 쓰므로(keywords.ts) 현재 질문을 맨 앞에, 그다음 최근 질문, 프로젝트 정보 순으로 둔다.
    // 프로젝트 설명이나 이전 질문이 길어도 지금 묻는 말의 검색어가 잘려 나가지 않게 하기 위해서다.
    const query = [question, ...history.map((h) => h.question).reverse(), project.title, project.purpose, project.audience, project.constraints]
      .filter(Boolean)
      .join("\n");
    const found = await findCandidates(task.team_id, query, { requireExternalAi: true, limit: MAX_KNOWLEDGE, includeAllIfAtMost: MAX_KNOWLEDGE, includeAiOnly: true });
    // 다시 쓰기라면 이전 입력 기록을 이번 입력으로 바꾼다 (지식이 없으면 비움)
    const recorded = found.length ? await recordInputs(requestId, task.team_id, found) : [];
    // 입력 기록 = 이번 검색으로 넘긴 지식 + 이어서 넘긴 이전 답변·대화 기억이 받았던 지식 (다시 쓰기라면 이전 기록을 바꾼다).
    // 모델 호출 전에 기록해 두므로, 답을 만드는 사이에 지식이 지워지거나 범위가 좁아지면 이 요청도 무효화된다(notes.ts).
    const inputIds = [...new Set([...recorded.map((c) => c.versionId), ...inherited, ...(memory?.ids ?? [])])];
    await db.query(
      "update advice_requests set input_version_ids = $2, candidate_count = $3 where id = $1",
      [requestId, inputIds, found.length],
    );
    // 입력을 기록한 뒤 공개 범위를 다시 읽는다. 검색과 기록 사이에 범위가 바뀌었다면 바뀐 범위로 넘긴다
    // (기록 뒤의 변경은 notes.ts 가 이 요청을 무효화한다).
    const live = recorded.length ? await withCurrentVisibility(recorded) : [];
    const byRef = new Map<string, Candidate>(live.map((c, i) => [`N${i + 1}`, c]));
    const knowledge: CandidateForAi[] = [...byRef].map(([ref, c]) => ({
      ref,
      text: c.origin === "meeting" ? clip(c.rawText, MAX_MEETING_CHARS) : c.rawText,
      summary: c.summary,
      conditions: c.conditions,
      meeting: c.origin === "meeting" ? { title: c.title ?? "", date: c.meetingDate ?? "" } : null,
      aiOnly: c.aiOnly,
      writtenOn: c.origin === "meeting" ? null : c.writtenOn,
    }));

    const kinds = new Map([...byRef].map(([ref, c]) => [ref, kindOf(c)] as const));
    const me = await db.query("select display_name from users where id = $1", [userId]);
    const askerName = (me.rows[0]?.display_name as string | undefined) ?? null;
    const out = await generate(provider, { project, askerName, today: todayKst(), memory: memory?.summary ?? null, history, knowledge, question }, kinds);
    const usedIds = out.used.map((r) => byRef.get(r)!.versionId);
    // 확정 직전 재확인은 실제로 반영한 지식만 대상으로 한다
    await finalize(requestId, userId, task.team_id, task.id, task.version, {
      items: [{ section: "answer", body: out.answer, evidence: usedIds.map((versionId) => ({ versionId, quote: null })), action: null }],
      dropped: out.dropped,
      emptyReason: null,
      inputIds: usedIds,
      // 이전 답변·기억을 읽은 뒤 입력을 기록하기 전 사이에 원래 지식이 지워졌다면 저장하지 않는다
      presentIds: inputIds,
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
    // 같은 요청 식별자가 이미 있다: 응답을 받지 못한 화면이 같은 질문을 다시 보낸 것이다.
    //  - 처리 중이거나 이미 답했다면 그 결과를 그대로 돌려준다 (질문을 두 번 저장하거나 모델을 두 번 부르지 않는다)
    //  - 실패로 끝났다면 같은 자리에서 다시 답한다. 실패 결과를 그대로 돌려주면 몇 번을 다시 보내도 실패만 보인다
    const ex = await db.query("select id from advice_requests where requester_id = $1 and client_request_id = $2", [userId, clientRequestId]);
    const existingId = ex.rows[0].id as string;
    await rerunFailed(userId, task, existingId, provider);
    return getChatTurn(userId, existingId);
  }
  const requestId = ins.rows[0].id as string;
  await audit(db, userId, "chat.ask", requestId, { provider: provider.name });
  await answer(userId, task, requestId, question, null, provider);
  return getChatTurn(userId, requestId);
}

/**
 * 실패로 끝난 질문을 같은 자리에서 다시 답한다 (모델 오류·시간 초과·처리 중 멈춤).
 * 실패한 요청만 대상이다. 여러 곳에서 동시에 다시 시도해도 상태를 원자적으로 바꾼 한쪽만 모델을 부른다.
 * 다시 답했으면 true, 대상이 아니면(처리 중·이미 답함·다른 프로젝트·남의 질문) false.
 */
async function rerunFailed(userId: string, task: TaskRow, requestId: string, provider: AiProvider): Promise<boolean> {
  const db = getPool();
  // 5분 넘게 '처리 중'으로 남은 요청(서버가 중간에 멈춘 경우)은 먼저 실패로 정리해 다시 시도할 수 있게 한다
  await markStale(db, "id = $1", [requestId]);
  const claim = await db.query(
    `update advice_requests r
     set status = 'pending', error = null, finished_at = null, started_at = now(), task_version = $4, provider = $5
     where r.id = $1 and r.requester_id = $2 and r.task_id = $3 and r.kind = 'chat' and r.status = 'failed'
     returning r.question, r.created_at::text as at_text,
       not exists (select 1 from advice_requests later
                   where later.task_id = r.task_id and later.requester_id = r.requester_id and later.kind = 'chat'
                     and later.created_at > r.created_at) as is_latest`,
    [requestId, userId, task.id, task.version, provider.name],
  );
  if (!claim.rowCount) return false;
  // 실패한 시도가 남긴 것이 있다면 지운다: 다시 실패해도 예전 내용이 되살아나지 않게
  await db.query("delete from advice_items where request_id = $1", [requestId]);
  await audit(db, userId, "chat.retry", requestId, { provider: provider.name });
  const row = claim.rows[0] as { question: string; at_text: string; is_latest: boolean };
  // 마지막 질문이면 새 질문처럼 답한다(대화 기억 포함). 그 뒤에 다른 질문이 있었다면 그 시점까지의 대화만 넘긴다
  await answer(userId, task, requestId, row.question, row.is_latest ? null : row.at_text, provider);
  return true;
}

/** 화면의 「다시 시도」: 실패한 내 질문을 같은 자리에서 다시 답한다. 실패 상태가 아니면 지금 상태를 그대로 돌려준다. */
export async function retryChatTurn(userId: string, taskId: string, requestId: string, provider: AiProvider) {
  const task = await loadTask(userId, taskId);
  if (!provider.isAi) throw aiUnavailable();
  await getChatTurn(userId, requestId); // 팀·소유 확인 (남의 질문·없는 질문은 404)
  await rerunFailed(userId, task, requestId, provider);
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
