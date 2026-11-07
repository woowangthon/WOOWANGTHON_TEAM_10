// 메모하기 → 메모 보기 → (골라서) AI 로 정리 → 직접 고침 → 팀에 공유
//
//  - '메모하기'로 쓴 메모(origin='memo')는 나만 본다. 공유하지 않는다.
//  - 메모 보기에서 내 메모 여러 개를 골라 AI 로 정리하면, 고른 메모만 모델에 간다.
//  - 정리문은 작성자가 고친 뒤 '팀에 공유'를 눌러야 팀 지식(origin='summary')이 된다. 이때 작성자가
//    보고 확정한 그 문장이 그대로 저장·공유된다(원문 그대로 확인한 것과 같은 상태). AI 없이 직접 써서 공유할 수도 있다.
//  - 공유한 정리는 다른 팀원에게 보이고, 대화에서 AI 가 참고한다. 철회·수정·삭제는 기존 메모 규칙을 따른다.
import { requireMembership } from "./access.ts";
import { aiUnavailable } from "./ai/providers.ts";
import { AiTimeout, aiTimeoutMs, withTimeout } from "./ai/timeout.ts";
import type { AiProvider } from "./ai/types.ts";
import { audit, getPool, withTx } from "./db.ts";
import { AppError, badRequest, conflict, notFound } from "./errors.ts";
import { confirmVersion, contentHash, editNote, invalidateAdviceForNote, shareNote } from "./notes.ts";
import { restatementWarnings } from "./restate-check.ts";
import { bool, cleanText, text, uuid } from "./validate.ts";

const MAX_SELECT = 20;
const MAX_SHARED_TEXT = 2000;

function noteIdList(value: unknown, field: string, { min }: { min: number }): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_SELECT)
    throw badRequest(`${field}는 ${min}~${MAX_SELECT}개여야 합니다.`);
  return [...new Set(value.map((v) => uuid(v, field)))];
}

/** 메모 보기: 내 메모(나만 봄) + 팀에 공유된 정리 */
export async function listMemos(userId: string, teamId: string) {
  const db = getPool();
  await requireMembership(db, userId, teamId);
  const mine = await db.query(
    `select n.id, v.id as version_id, v.raw_text, n.updated_at, n.created_at,
            exists (select 1 from note_sources s join notes x on x.id = s.note_id
                    where s.source_note_id = n.id and x.share_state = 'shared') as in_shared
     from notes n
     join lateral (select * from note_versions nv where nv.note_id = n.id order by nv.version desc limit 1) v on true
     where n.team_id = $1 and n.author_id = $2 and n.origin = 'memo' and n.share_state = 'draft'
     order by n.created_at desc`,
    [teamId, userId],
  );
  const shared = await db.query(
    `select n.id, n.share_state, n.author_id = $2 as is_author, u.display_name as author_name, n.allow_external_ai, n.updated_at,
            v.id as version_id, v.raw_text, v.version
     from notes n
     join users u on u.id = n.author_id
     join lateral (
       select * from note_versions nv
       where nv.note_id = n.id and (case when n.author_id = $2 then true else nv.id = n.current_version_id end)
       order by nv.version desc limit 1
     ) v on true
     where n.team_id = $1 and n.origin <> 'meeting' -- 회의록은 회의록 화면에서 따로 본다
       and (n.share_state = 'shared' or (n.author_id = $2 and (n.origin = 'summary' or n.share_state = 'withdrawn')))
     order by n.updated_at desc`,
    [teamId, userId],
  );
  return {
    mine: mine.rows.map((r) => ({ id: r.id as string, versionId: r.version_id as string, text: r.raw_text as string, createdAt: r.created_at, inShared: r.in_shared as boolean })),
    shared: shared.rows.map((r) => ({
      id: r.id as string,
      versionId: r.version_id as string,
      text: r.raw_text as string,
      state: r.share_state as "shared" | "withdrawn" | "draft",
      isAuthor: r.is_author as boolean,
      authorName: r.author_name as string,
      allowExternalAi: r.allow_external_ai as boolean,
      updatedAt: r.updated_at,
    })),
  };
}

/** 내 메모(이 팀, 공유 전)를 골라 읽는다. 남의 메모·다른 팀·삭제된 메모는 구분 없이 404. */
async function loadOwnMemos(userId: string, teamId: string, ids: string[]) {
  const r = await getPool().query(
    `select n.id, v.raw_text from notes n
     join lateral (select raw_text from note_versions nv where nv.note_id = n.id order by nv.version desc limit 1) v on true
     where n.id = any($1::uuid[]) and n.team_id = $2 and n.author_id = $3 and n.origin = 'memo' and n.share_state = 'draft'`,
    [ids, teamId, userId],
  );
  if (r.rowCount !== ids.length) throw notFound();
  const byId = new Map(r.rows.map((x) => [x.id as string, x.raw_text as string]));
  return ids.map((id) => byId.get(id)!);
}

/** 고른 메모만 모델에 보내 정리문 초안을 받는다. 저장하지 않는다(작성자가 고친 뒤 공유할 때 저장). */
export async function summarizeMemos(userId: string, teamId: string, input: { noteIds: unknown }, provider: AiProvider) {
  const ids = noteIdList(input.noteIds, "정리할 메모", { min: 1 });
  const db = getPool();
  await requireMembership(db, userId, teamId);
  if (!provider.isAi) throw aiUnavailable();
  const memos = await loadOwnMemos(userId, teamId, ids);

  let output: unknown;
  provider.drainUsage?.();
  try {
    output = await withTimeout(provider.summarize({ memos }), aiTimeoutMs());
  } catch (err) {
    if (err instanceof AiTimeout) throw new AppError(504, "ai_timeout", "AI 응답이 늦어 중단했습니다. 다시 시도하거나 직접 정리해 주세요.");
    console.error("summarize failed", (err as Error)?.name, String((err as Error)?.message).slice(0, 200));
    throw new AppError(502, "ai_error", "AI 정리에 실패했습니다. 다시 시도하거나 직접 정리해 주세요.");
  } finally {
    const usage = provider.drainUsage?.() ?? [];
    if (usage.length) await audit(db, userId, "memo.summarize", teamId, { count: ids.length, provider: provider.name, usage });
  }
  const raw = output && typeof output === "object" ? (output as Record<string, unknown>).text : undefined;
  if (typeof raw !== "string" || !cleanText(raw)) throw new AppError(502, "invalid_ai_output", "AI 정리 결과의 형식이 올바르지 않습니다. 직접 정리해 주세요.");
  const summary = raw.trim().slice(0, MAX_SHARED_TEXT);
  return { text: summary, warnings: restatementWarnings(memos.join("\n"), { summary, conditions: [], uncertainties: [] }) };
}

/**
 * 작성자가 확정한 정리문을 팀에 공유한다. 한 트랜잭션에서 메모 생성 → 확정(작성자가 본 그대로) → 공유.
 * sourceNoteIds: 이 정리의 바탕이 된 내 메모 (없어도 됨: 직접 쓴 정리)
 */
export async function shareSummary(
  userId: string,
  teamId: string,
  input: { text: unknown; sourceNoteIds?: unknown; allowExternalAi?: unknown },
) {
  const body = text(input.text, "공유할 내용", { min: 1, max: MAX_SHARED_TEXT });
  const sources = input.sourceNoteIds === undefined || (Array.isArray(input.sourceNoteIds) && input.sourceNoteIds.length === 0)
    ? []
    : noteIdList(input.sourceNoteIds, "바탕 메모", { min: 1 });
  const allowExternalAi = bool(input.allowExternalAi, "AI 참고 허용", true);
  return withTx(async (tx) => {
    await requireMembership(tx, userId, teamId);
    if (sources.length) {
      const own = await tx.query(
        "select count(*)::int as c from notes where id = any($1::uuid[]) and team_id = $2 and author_id = $3 and origin = 'memo'",
        [sources, teamId, userId],
      );
      if (own.rows[0].c !== sources.length) throw notFound();
    }
    const n = await tx.query(
      "insert into notes (team_id, author_id, allow_external_ai, origin) values ($1, $2, $3, 'summary') returning id",
      [teamId, userId, allowExternalAi],
    );
    const noteId = n.rows[0].id as string;
    const v = await tx.query(
      `insert into note_versions (note_id, team_id, version, raw_text, content_hash, intent_state, confirmed_by, confirmed_at,
                                  search_text, index_state)
       values ($1, $2, 1, $3, $4, 'raw_only', $5, now(), $3, 'ready') returning id`,
      [noteId, teamId, body, contentHash(body, null), userId],
    );
    await tx.query("update notes set share_state = 'shared', current_version_id = $1, updated_at = now() where id = $2", [
      v.rows[0].id,
      noteId,
    ]);
    for (const s of sources) await tx.query("insert into note_sources (note_id, source_note_id) values ($1, $2)", [noteId, s]);
    await audit(tx, userId, "memo.share", noteId, { sources: sources.length, allowExternalAi });
    return { noteId, versionId: v.rows[0].id as string };
  });
}

/** 공유한 정리를 고쳐서 다시 공유한다 (철회된 것도). 기존 규칙대로 이전 버전에 기댄 답변은 숨겨진다. */
export async function reviseShared(userId: string, noteId: string, input: { text: unknown }) {
  // 개인 메모(공유 전)는 이 경로로 공유하지 않는다: 반드시 '메모 보기'에서 골라 확정한 정리로만 공유
  const n = await getPool().query("select origin, share_state from notes where id = $1 and author_id = $2", [noteId, userId]);
  if (!n.rowCount || (n.rows[0].origin === "memo" && n.rows[0].share_state === "draft")) throw notFound();
  const edited = await editNote(userId, noteId, input.text);
  const c = await confirmVersion(userId, noteId, edited.versionId, { choice: "raw_only", expectedHash: edited.contentHash });
  if (c.intentState !== "raw_only") throw conflict("다시 시도해 주세요.");
  return shareNote(userId, noteId, edited.versionId);
}

/**
 * 공유한 지식을 AI 가 대화에서 참고할지 바꾼다. 끄면 그 지식을 반영한 답변은 다음에 열 때 조용히 다시 쓰이고,
 * 이어지는 대화에서도 그 지식이 넘어갔던 답변은 빠진다(chat.ts).
 */
export async function setAiReference(userId: string, noteId: string, input: { allowExternalAi: unknown }) {
  if (typeof input.allowExternalAi !== "boolean") throw badRequest("AI 참고 허용 값이 올바르지 않습니다.");
  const allow = input.allowExternalAi;
  return withTx(async (tx) => {
    const r = await tx.query("select team_id, author_id, allow_external_ai, origin, share_state from notes where id = $1 for update", [noteId]);
    const n = r.rows[0];
    if (!n || n.author_id !== userId || (n.origin === "memo" && n.share_state === "draft")) throw notFound();
    await requireMembership(tx, userId, n.team_id);
    if (n.allow_external_ai === allow) return { noteId, allowExternalAi: allow, invalidated: 0 };
    await tx.query("update notes set allow_external_ai = $2, updated_at = now() where id = $1", [noteId, allow]);
    const invalidated = allow ? 0 : await invalidateAdviceForNote(tx, noteId);
    await audit(tx, userId, "note.ai_reference", noteId, { allow, invalidated });
    return { noteId, allowExternalAi: allow, invalidated };
  });
}
