// 회의록: 팀원끼리 회의한 내용을 기록해 두면, 대화할 때 AI 가 다른 팀 지식처럼 참고한다.
//
// 이 서비스는 회의를 대신하려는 것이 아니다. 회의에서 정한 것·남은 문제를 기록해 두면, 그 맥락 위에서 AI 가 답한다.
//  - 회의록은 쓰는 즉시 팀에 공유된다(메모처럼 정리 단계를 거치지 않음).
//  - 팀 기록이므로 **팀원 누구나 고칠 수 있다**. 고칠 때마다 새 버전을 남기고 버전마다 고친 사람·시각·제목·날짜를 기록해,
//    누가 어떤 부분을 고쳤는지 볼 수 있다(수정 기록). 두 사람이 동시에 고치면 나중에 저장한 쪽이 앞사람의 수정을
//    덮어쓰지 않도록, 고치기 시작한 버전이 아직 최신일 때만 저장한다.
//  - 공유 철회·다시 공유·삭제·AI 참고 끄기는 처음 쓴 사람이나 팀장만 한다(팀 기록을 한 사람이 지우지 못하게).
//  - 쓴 사람이 탈퇴해도 공유된 회의록은 남는다(작성자 표시는 "탈퇴한 사용자"). account.ts 참고.
//  - 저장 형태는 메모의 한 종류(notes.origin = 'meeting'): 철회·삭제·AI 참고 끄기·조용한 다시 쓰기·출처 비노출 규칙을 그대로 따른다.
import type { PoolClient } from "pg";
import { requireMembership } from "./access.ts";
import { audit, getPool, withTx } from "./db.ts";
import { AppError, badRequest, conflict, notFound } from "./errors.ts";
import { contentHash, invalidateAdviceForNote, purgeAdviceForNote } from "./notes.ts";
import { bool, text, uuid } from "./validate.ts";

const MAX_MEETING = 10_000;
const HISTORY_LIMIT = 30;
const GONE = "탈퇴한 사용자";

function meetingDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw badRequest("회의 날짜 형식이 올바르지 않습니다 (예: 2026-11-07).");
  return value;
}

type MeetingInput = { title: unknown; date: unknown; text: unknown; allowExternalAi?: unknown; baseVersionId?: unknown };

function parse(input: MeetingInput) {
  return {
    title: text(input.title, "회의 제목", { min: 1, max: 200 }),
    date: meetingDate(input.date),
    body: text(input.text, "회의 내용", { min: 1, max: MAX_MEETING }),
  };
}

async function insertVersion(
  tx: PoolClient,
  noteId: string,
  teamId: string,
  version: number,
  m: { title: string; date: string; body: string },
  userId: string,
) {
  const v = await tx.query(
    `insert into note_versions (note_id, team_id, version, raw_text, content_hash, intent_state, confirmed_by, confirmed_at,
                                search_text, index_state, title, meeting_date)
     values ($1, $2, $3, $4, $5, 'raw_only', $6, now(), $7, 'ready', $8, $9) returning id`,
    [noteId, teamId, version, m.body, contentHash(m.body, null), userId, `${m.title}\n${m.body}`, m.title, m.date],
  );
  return v.rows[0].id as string;
}

export async function createMeeting(userId: string, teamId: string, input: MeetingInput) {
  const m = parse(input);
  const allowExternalAi = bool(input.allowExternalAi, "AI 참고 허용", true);
  return withTx(async (tx) => {
    await requireMembership(tx, userId, teamId);
    const n = await tx.query(
      `insert into notes (team_id, author_id, allow_external_ai, origin, title, meeting_date)
       values ($1, $2, $3, 'meeting', $4, $5) returning id`,
      [teamId, userId, allowExternalAi, m.title, m.date],
    );
    const noteId = n.rows[0].id as string;
    const versionId = await insertVersion(tx, noteId, teamId, 1, m, userId);
    await tx.query("update notes set share_state = 'shared', current_version_id = $1, updated_at = now() where id = $2", [versionId, noteId]);
    await audit(tx, userId, "meeting.create", noteId, { allowExternalAi });
    return { noteId, versionId };
  });
}

/** 회의록을 잠그고 읽는다. 다른 팀·회의록이 아닌 것·팀원이 아닌 사람은 구분 없이 404. */
async function lockMeeting(tx: PoolClient, userId: string, noteId: string) {
  const r = await tx.query(
    `select n.id, n.team_id, n.author_id, n.origin, n.title, n.meeting_date::text as meeting_date, n.share_state, n.current_version_id,
            n.allow_external_ai, v.raw_text, (select max(version) from note_versions x where x.note_id = n.id) as latest
     from notes n left join note_versions v on v.id = n.current_version_id
     where n.id = $1 for update of n`,
    [noteId],
  );
  const n = r.rows[0];
  if (!n || n.origin !== "meeting") throw notFound();
  const { role } = await requireMembership(tx, userId, n.team_id);
  return { ...n, canManage: n.author_id === userId || role === "lead" };
}

const cannotManage = () => new AppError(403, "forbidden", "회의록을 처음 쓴 사람이나 팀장만 할 수 있습니다.");

/**
 * 회의록 고치기 (팀원 누구나). 바뀐 것이 있으면 새 버전을 남긴다(고친 사람 기록).
 * baseVersionId: 고치기 시작할 때의 버전. 그 사이 다른 팀원이 고쳤다면 거부해 앞사람의 수정을 덮어쓰지 않는다.
 * 바뀐 것이 있으면 이전 버전을 반영한 답변은 조용히 다시 쓰이게 한다(날짜도 최근 회의 판단에 쓰이므로 포함).
 */
export async function updateMeeting(userId: string, noteId: string, input: MeetingInput) {
  const m = parse(input);
  const base = input.baseVersionId === undefined || input.baseVersionId === null ? null : uuid(input.baseVersionId, "baseVersionId");
  return withTx(async (tx) => {
    const n = await lockMeeting(tx, userId, noteId);
    if (n.share_state !== "shared" && !n.canManage) throw notFound(); // 철회된 회의록은 관리자만 본다
    if (base && base !== n.current_version_id)
      throw conflict("그 사이 다른 팀원이 이 회의록을 고쳤습니다. 새로 불러온 뒤 다시 고쳐 주세요.");
    const contentChanged = n.title !== m.title || n.raw_text !== m.body;
    const dateChanged = n.meeting_date !== m.date;
    if (!contentChanged && !dateChanged) return { noteId, versionId: n.current_version_id as string, changed: false };
    const versionId = await insertVersion(tx, noteId, n.team_id, Number(n.latest) + 1, m, userId);
    await tx.query("update notes set current_version_id = $2, title = $3, meeting_date = $4, updated_at = now() where id = $1", [
      noteId,
      versionId,
      m.title,
      m.date,
    ]);
    // 날짜도 "어느 회의가 최근인가"를 바꾸므로, 무엇이든 바뀌면 이 회의록을 반영한 답변은 조용히 다시 쓴다
    const invalidated = await invalidateAdviceForNote(tx, noteId);
    await audit(tx, userId, "meeting.update", noteId, { contentChanged, dateChanged, invalidated });
    return { noteId, versionId, changed: true };
  });
}

/** 공유 철회 / 다시 공유 / 삭제 / AI 참고 켜고 끄기 — 처음 쓴 사람이나 팀장만 */
export async function manageMeeting(
  userId: string,
  noteId: string,
  input: { action: unknown; allowExternalAi?: unknown },
) {
  const action = input.action;
  if (!["withdraw", "share", "delete", "ai"].includes(action as string)) throw badRequest("알 수 없는 동작입니다.");
  return withTx(async (tx) => {
    const n = await lockMeeting(tx, userId, noteId);
    if (!n.canManage) throw n.share_state === "shared" ? cannotManage() : notFound();
    let invalidated = 0;
    if (action === "withdraw") {
      if (n.share_state !== "shared") throw conflict("공유 중인 회의록만 철회할 수 있습니다.");
      await tx.query("update notes set share_state = 'withdrawn', updated_at = now() where id = $1", [noteId]);
      invalidated = await invalidateAdviceForNote(tx, noteId);
    } else if (action === "share") {
      if (n.share_state === "shared") return { noteId, state: "shared" };
      await tx.query("update notes set share_state = 'shared', updated_at = now() where id = $1", [noteId]);
    } else if (action === "ai") {
      if (typeof input.allowExternalAi !== "boolean") throw badRequest("AI 참고 허용 값이 올바르지 않습니다.");
      await tx.query("update notes set allow_external_ai = $2, updated_at = now() where id = $1", [noteId, input.allowExternalAi]);
      if (!input.allowExternalAi && n.allow_external_ai) invalidated = await invalidateAdviceForNote(tx, noteId);
    } else {
      invalidated = await invalidateAdviceForNote(tx, noteId);
      await purgeAdviceForNote(tx, noteId);
      await tx.query("delete from notes where id = $1", [noteId]);
    }
    await audit(tx, userId, `meeting.${action}`, noteId, { invalidated });
    return { noteId, action };
  });
}

/** 회의록 목록: 공유 중인 것 + (처음 쓴 사람·팀장에게는) 철회된 것. 최근 회의부터. */
export async function listMeetings(userId: string, teamId: string) {
  const db = getPool();
  const { role } = await requireMembership(db, userId, teamId);
  const r = await db.query(
    `select n.id, n.title, n.meeting_date::text as date, n.share_state, n.allow_external_ai, n.updated_at, n.created_at,
            n.author_id = $2 as is_author, coalesce(u.display_name, $4) as author_name,
            v.id as version_id, v.raw_text, v.version, v.confirmed_at as edited_at, coalesce(e.display_name, $4) as editor_name
     from notes n
     left join users u on u.id = n.author_id
     join note_versions v on v.id = n.current_version_id
     left join users e on e.id = v.confirmed_by
     where n.team_id = $1 and n.origin = 'meeting'
       and (n.share_state = 'shared' or (n.share_state = 'withdrawn' and (n.author_id = $2 or $3)))
     order by n.meeting_date desc, n.created_at desc`,
    [teamId, userId, role === "lead", GONE],
  );
  return r.rows.map((x) => ({
    id: x.id as string,
    versionId: x.version_id as string,
    version: x.version as number,
    title: x.title as string,
    date: x.date as string,
    text: x.raw_text as string,
    state: x.share_state as "shared" | "withdrawn",
    allowExternalAi: x.allow_external_ai as boolean,
    isAuthor: !!x.is_author,
    canManage: !!x.is_author || role === "lead",
    authorName: x.author_name as string,
    createdAt: x.created_at,
    lastEditedBy: x.editor_name as string,
    lastEditedAt: x.edited_at,
  }));
}

/** 수정 기록: 버전마다 고친 사람·시각·제목·날짜·내용 (최근 것부터). 화면이 앞뒤 버전을 비교해 바뀐 부분을 보여준다. */
export async function meetingHistory(userId: string, noteId: string) {
  const db = getPool();
  const n = await db.query("select team_id, origin, share_state, author_id from notes where id = $1", [noteId]);
  const note = n.rows[0];
  if (!note || note.origin !== "meeting") throw notFound();
  const { role } = await requireMembership(db, userId, note.team_id);
  if (note.share_state !== "shared" && note.author_id !== userId && role !== "lead") throw notFound();
  const r = await db.query(
    `select v.id, v.version, v.title, v.meeting_date::text as date, v.raw_text, v.confirmed_at as at, coalesce(u.display_name, $3) as editor_name
     from note_versions v left join users u on u.id = v.confirmed_by
     where v.note_id = $1 order by v.version desc limit $2`,
    [noteId, HISTORY_LIMIT + 1, GONE],
  );
  return r.rows.map((x) => ({
    versionId: x.id as string,
    version: x.version as number,
    title: x.title as string | null,
    date: x.date as string | null,
    text: x.raw_text as string,
    at: x.at,
    editorName: x.editor_name as string,
  }));
}
