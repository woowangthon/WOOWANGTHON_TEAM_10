// 메모와 메모 버전의 수명 주기.
// 원칙 (docs/구현_구체화.md §5·§7, 원안 §6.3):
//  - 작성자가 "정확한 버전"을 확인해야 공유할 수 있다 (content_hash 로 고정).
//  - 공유 중인 메모를 고치면 기존 공유를 검색에서 내리고 새 버전은 다시 확인해야 한다.
//  - 철회·삭제하면 즉시 검색에서 빠지고, 그 메모를 근거로 쓴 조언은 무효화된다.
//  - 다른 사람의 초안은 존재 여부도 알려주지 않는다 (404).
import { createHash } from "node:crypto";
import type pg from "pg";
import { requireMembership } from "./access.ts";
import { audit, getPool, withTx, type Db } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { bool, cleanText, text } from "./validate.ts";

export const NOTE_KINDS = ["proposal", "guess", "question", "objection"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export type Restated = {
  summary: string;
  kind: NoteKind;
  conditions: string[];
  uncertainties: string[];
  clarifying_question: string | null;
};

export type ConfirmChoice = "confirmed" | "edited" | "raw_only";

const MAX_RAW = 2000;

export function contentHash(rawText: string, restated: Restated | null): string {
  // 키 순서를 고정해서 같은 내용이면 항상 같은 해시가 나오게 한다
  const canonical = JSON.stringify({
    raw: rawText,
    restated: restated && {
      summary: restated.summary,
      kind: restated.kind,
      conditions: restated.conditions,
      uncertainties: restated.uncertainties,
      clarifying_question: restated.clarifying_question,
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseRestated(value: unknown): Restated {
  if (!value || typeof value !== "object") throw badRequest("정리 결과 형식이 올바르지 않습니다.");
  const v = value as Record<string, unknown>;
  const strList = (x: unknown, field: string) => {
    if (!Array.isArray(x) || x.length > 10 || !x.every((s) => typeof s === "string" && s.length <= 300))
      throw badRequest(`${field} 형식이 올바르지 않습니다.`);
    return (x as string[]).map(cleanText).filter(Boolean);
  };
  if (!NOTE_KINDS.includes(v.kind as NoteKind)) throw badRequest("메모 성격 값이 올바르지 않습니다.");
  const cq = v.clarifying_question;
  if (cq !== null && (typeof cq !== "string" || cq.length > 300)) throw badRequest("보충 질문 형식이 올바르지 않습니다.");
  return {
    summary: text(typeof v.summary === "string" ? cleanText(v.summary) : v.summary, "정리문", { min: 1, max: 600 }),
    kind: v.kind as NoteKind,
    conditions: strList(v.conditions, "조건"),
    uncertainties: strList(v.uncertainties, "불확실성"),
    clarifying_question: typeof cq === "string" ? cleanText(cq) || null : null,
  };
}

function buildSearchText(rawText: string, restated: Restated | null): string {
  if (!restated) return rawText;
  return [rawText, restated.summary, ...restated.conditions, ...restated.uncertainties].join("\n");
}

async function lockOwnNote(tx: pg.PoolClient, userId: string, noteId: string) {
  const r = await tx.query("select * from notes where id = $1 for update", [noteId]);
  const note = r.rows[0];
  // 남의 메모 / 없는 메모 / 삭제된 메모를 구분하지 않는다
  if (!note || note.author_id !== userId || note.share_state === "deleted") throw notFound();
  await requireMembership(tx, userId, note.team_id);
  return note;
}

async function getVersionOf(tx: Db, noteId: string, versionId: string) {
  const r = await tx.query("select * from note_versions where id = $1 and note_id = $2", [versionId, noteId]);
  if (!r.rowCount) throw notFound();
  return r.rows[0];
}

async function latestVersion(tx: Db, noteId: string) {
  const r = await tx.query("select * from note_versions where note_id = $1 order by version desc limit 1", [noteId]);
  return r.rows[0];
}

const NOTE_VERSION_IDS = "(select coalesce(array_agg(id), '{}') from note_versions where note_id = $1)";

/**
 * 이 메모의 영향을 받은 조언 요청.
 *  - 조언(kind='advice'): 모델·화면에 넘긴 메모 전체(input_version_ids) 기준. 모델은 받은 메모 전체의 영향을 받을 수 있다.
 *  - 대화(kind='chat'): 모델이 답변에 반영했다고 밝힌 메모(evidence_version_ids) 기준. 작은 팀은 공유 메모를 매번 전부 건네므로,
 *    입력 기준으로 하면 메모 하나를 철회할 때마다 모든 대화가 사라진다. 대신 처리 중인 요청은 확정 직전에 반영 메모를 다시 확인한다.
 */
const AFFECTED_BY_NOTE = `(
  (advice_requests.kind = 'advice' and advice_requests.input_version_ids && ${NOTE_VERSION_IDS})
  or (advice_requests.kind = 'chat' and exists (
        select 1 from advice_items ai where ai.request_id = advice_requests.id and ai.evidence_version_ids && ${NOTE_VERSION_IDS}))
)`;

/**
 * 이 메모(어느 버전이든)를 모델·화면에 넘겼던 조언 요청을 무효화한다.
 * 모델은 받은 메모 전체의 영향을 받을 수 있으므로, 근거로 인용하지 않은 항목까지 요청 단위로 무효화한다.
 */
export async function invalidateAdviceForNote(tx: Db, noteId: string): Promise<number> {
  const r = await tx.query(
    `update advice_requests
     set status = 'invalidated', error = coalesce(error, 'source_changed'), finished_at = coalesce(finished_at, now())
     where status in ('pending', 'ok') and ${AFFECTED_BY_NOTE}`,
    [noteId],
  );
  return r.rowCount ?? 0;
}

/** 메모 삭제 시: 그 메모를 넘겼던 요청의 조언 본문·인용을 DB 에서 지운다. */
export async function purgeAdviceForNote(tx: Db, noteId: string): Promise<number> {
  const r = await tx.query(
    `update advice_items set body = '', quotes = '[]'::jsonb, purged = true
     where request_id in (select id from advice_requests where ${AFFECTED_BY_NOTE})`,
    [noteId],
  );
  return r.rowCount ?? 0;
}

export async function createNote(userId: string, teamId: string, input: { rawText: unknown; allowExternalAi?: unknown }) {
  const rawText = text(input.rawText, "메모", { min: 1, max: MAX_RAW });
  const allowExternalAi = bool(input.allowExternalAi, "AI 정리 허용", true);
  return withTx(async (tx) => {
    await requireMembership(tx, userId, teamId);
    const n = await tx.query(
      "insert into notes (team_id, author_id, allow_external_ai) values ($1, $2, $3) returning id",
      [teamId, userId, allowExternalAi],
    );
    const noteId = n.rows[0].id as string;
    const v = await tx.query(
      `insert into note_versions (note_id, team_id, version, raw_text, content_hash)
       values ($1, $2, 1, $3, $4) returning id, content_hash`,
      [noteId, teamId, rawText, contentHash(rawText, null)],
    );
    await audit(tx, userId, "note.create", noteId);
    return { noteId, versionId: v.rows[0].id as string, contentHash: v.rows[0].content_hash as string };
  });
}

/** AI 정리 결과를 최신 미확인 버전에 붙인다. 확인은 별도 단계(confirmVersion). */
export async function setRestatement(
  userId: string,
  noteId: string,
  versionId: string,
  restatedInput: unknown,
  opts: { expectedHash?: string } = {},
) {
  const restated = parseRestated(restatedInput);
  return withTx(async (tx) => {
    const note = await lockOwnNote(tx, userId, noteId);
    if (!note.allow_external_ai) throw conflict("이 메모는 AI 정리를 허용하지 않았습니다.");
    const version = await getVersionOf(tx, noteId, versionId);
    if (opts.expectedHash !== undefined && version.content_hash !== opts.expectedHash)
      throw conflict("정리하는 사이 메모가 바뀌었습니다. 다시 정리해 주세요.");
    const latest = await latestVersion(tx, noteId);
    if (latest.id !== version.id || version.intent_state !== "unconfirmed")
      throw conflict("최신 미확인 버전에만 정리 결과를 붙일 수 있습니다.");
    const hash = contentHash(version.raw_text, restated);
    await tx.query("update note_versions set restated = $1, kind = $2, content_hash = $3 where id = $4", [
      JSON.stringify(restated),
      restated.kind,
      hash,
      versionId,
    ]);
    return { versionId, contentHash: hash };
  });
}

/**
 * 작성자가 특정 버전의 의도를 확인한다.
 * expectedHash: 화면에 보여준 내용의 해시. 그 사이 내용이 바뀌었다면 거부한다.
 */
export async function confirmVersion(
  userId: string,
  noteId: string,
  versionId: string,
  input: { choice: unknown; expectedHash: unknown; editedSummary?: unknown },
) {
  const choice = input.choice as ConfirmChoice;
  if (!["confirmed", "edited", "raw_only"].includes(choice)) throw badRequest("확인 선택값이 올바르지 않습니다.");
  if (typeof input.expectedHash !== "string") throw badRequest("확인할 내용의 해시가 필요합니다.");

  return withTx(async (tx) => {
    await lockOwnNote(tx, userId, noteId);
    const version = await getVersionOf(tx, noteId, versionId);
    const latest = await latestVersion(tx, noteId);
    if (latest.id !== version.id) throw conflict("최신 버전만 확인할 수 있습니다.");
    if (version.content_hash !== input.expectedHash) throw conflict("확인하려던 내용이 바뀌었습니다. 다시 확인해 주세요.");

    let restated: Restated | null = version.restated;
    let intent: "confirmed" | "raw_only" = "confirmed";
    if (choice === "raw_only") {
      restated = null;
      intent = "raw_only";
    } else if (choice === "confirmed") {
      if (!restated) throw conflict("확인할 정리문이 없습니다. '원문 그대로'를 선택해 주세요.");
    } else {
      if (!restated) throw conflict("고칠 정리문이 없습니다.");
      restated = { ...restated, summary: text(input.editedSummary, "고친 정리문", { min: 1, max: 600 }) };
    }
    const hash = contentHash(version.raw_text, restated);
    await tx.query(
      `update note_versions set restated = $1, kind = $2, intent_state = $3, content_hash = $4,
         confirmed_by = $5, confirmed_at = now()
       where id = $6`,
      [restated ? JSON.stringify(restated) : null, restated?.kind ?? null, intent, hash, userId, versionId],
    );
    await audit(tx, userId, "note.confirm", noteId, { versionId, choice });
    return { versionId, intentState: intent, contentHash: hash };
  });
}

/** 확인된 버전을 팀에 공유한다. */
export async function shareNote(userId: string, noteId: string, versionId: string) {
  return withTx(async (tx) => {
    await lockOwnNote(tx, userId, noteId);
    const version = await getVersionOf(tx, noteId, versionId);
    const latest = await latestVersion(tx, noteId);
    if (latest.id !== version.id) throw conflict("최신 버전만 공유할 수 있습니다.");
    if (version.intent_state === "unconfirmed") throw conflict("작성자가 의도를 확인한 버전만 공유할 수 있습니다.");
    await tx.query("update note_versions set search_text = $1, index_state = 'ready' where id = $2", [
      buildSearchText(version.raw_text, version.restated),
      versionId,
    ]);
    await tx.query(
      "update notes set share_state = 'shared', current_version_id = $1, updated_at = now() where id = $2",
      [versionId, noteId],
    );
    await audit(tx, userId, "note.share", noteId, { versionId });
    return { noteId, versionId, shareState: "shared" as const };
  });
}

/** 메모 수정: 새 미확인 버전을 만들고, 공유 중이었다면 공유를 내린다. */
export async function editNote(userId: string, noteId: string, rawTextInput: unknown) {
  const rawText = text(rawTextInput, "메모", { min: 1, max: MAX_RAW });
  return withTx(async (tx) => {
    const note = await lockOwnNote(tx, userId, noteId);
    const latest = await latestVersion(tx, noteId);
    const v = await tx.query(
      `insert into note_versions (note_id, team_id, version, raw_text, content_hash)
       values ($1, $2, $3, $4, $5) returning id, content_hash`,
      [noteId, note.team_id, latest.version + 1, rawText, contentHash(rawText, null)],
    );
    let invalidated = 0;
    if (note.share_state === "shared") {
      await tx.query("update notes set share_state = 'draft', current_version_id = null, updated_at = now() where id = $1", [
        noteId,
      ]);
      invalidated = await invalidateAdviceForNote(tx, noteId);
    }
    await audit(tx, userId, "note.edit", noteId, { wasShared: note.share_state === "shared", invalidated });
    return { versionId: v.rows[0].id as string, contentHash: v.rows[0].content_hash as string, unshared: note.share_state === "shared" };
  });
}

export async function withdrawNote(userId: string, noteId: string) {
  return withTx(async (tx) => {
    const note = await lockOwnNote(tx, userId, noteId);
    if (note.share_state !== "shared") throw conflict("공유 중인 메모만 철회할 수 있습니다.");
    await tx.query("update notes set share_state = 'withdrawn', updated_at = now() where id = $1", [noteId]);
    const invalidated = await invalidateAdviceForNote(tx, noteId);
    await audit(tx, userId, "note.withdraw", noteId, { invalidated });
    return { noteId, shareState: "withdrawn" as const, invalidatedAdvice: invalidated };
  });
}

/** 삭제: 원문·버전을 지운다. 이 메모를 근거로 쓴 조언은 무효화된다. */
export async function deleteNote(userId: string, noteId: string) {
  return withTx(async (tx) => {
    await lockOwnNote(tx, userId, noteId);
    const invalidated = await invalidateAdviceForNote(tx, noteId);
    const purged = await purgeAdviceForNote(tx, noteId);
    await tx.query("delete from notes where id = $1", [noteId]);
    await audit(tx, userId, "note.delete", noteId, { invalidated, purged });
    return { noteId, deleted: true, invalidatedAdvice: invalidated };
  });
}

type PublicVersion = {
  id: string;
  version: number;
  raw_text: string;
  restated: Restated | null;
  intent_state: string;
  kind: string | null;
  fact_state: string;
  content_hash: string;
};

const VERSION_COLS = "id, version, raw_text, restated, intent_state, kind, fact_state, content_hash";

/** 메모 상세. 작성자는 모든 버전을, 팀원은 공유 중인 현재 버전만 본다. */
export async function getNote(userId: string, noteId: string) {
  const db = getPool();
  const r = await db.query(
    `select n.id, n.team_id, n.author_id, n.share_state, n.current_version_id, n.allow_external_ai, u.display_name as author_name
     from notes n join users u on u.id = n.author_id where n.id = $1`,
    [noteId],
  );
  const note = r.rows[0];
  if (!note) throw notFound();
  await requireMembership(db, userId, note.team_id);
  const isAuthor = note.author_id === userId;
  if (!isAuthor && note.share_state !== "shared") throw notFound();

  const versions = isAuthor
    ? (await db.query(`select ${VERSION_COLS} from note_versions where note_id = $1 order by version`, [noteId])).rows
    : (await db.query(`select ${VERSION_COLS} from note_versions where id = $1`, [note.current_version_id])).rows;

  return {
    id: note.id as string,
    teamId: note.team_id as string,
    authorName: note.author_name as string,
    isAuthor,
    shareState: note.share_state as string,
    currentVersionId: note.current_version_id as string | null,
    allowExternalAi: note.allow_external_ai as boolean,
    versions: versions as PublicVersion[],
  };
}

/** 팀 메모 목록: 공유 중인 메모 + 내 메모(초안·철회 포함). */
export async function listNotes(userId: string, teamId: string) {
  const db = getPool();
  await requireMembership(db, userId, teamId);
  const r = await db.query(
    `select n.id, n.share_state, n.allow_external_ai, n.author_id = $2 as is_author, u.display_name as author_name, n.updated_at,
            v.id as version_id, v.content_hash, v.raw_text, v.restated, v.intent_state, v.version
     from notes n
     join users u on u.id = n.author_id
     join lateral (
       select * from note_versions nv
       where nv.note_id = n.id
         and (case when n.author_id = $2 then true else nv.id = n.current_version_id end)
       order by nv.version desc limit 1
     ) v on true
     where n.team_id = $1 and (n.share_state = 'shared' or n.author_id = $2)
     order by n.updated_at desc`,
    [teamId, userId],
  );
  return r.rows;
}
