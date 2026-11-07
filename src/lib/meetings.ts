// 회의록: 팀원끼리 회의한 내용을 기록해 두면, 대화할 때 AI 가 다른 팀 지식처럼 참고한다.
//
// 이 서비스는 회의를 대신하려는 것이 아니다. 회의에서 정한 것·남은 문제를 기록해 두면, 그 맥락 위에서 AI 가 답한다.
//  - 회의록은 쓰는 즉시 팀에 공유된다(쓴 사람이 확인한 기록이므로 메모처럼 정리 단계를 거치지 않음).
//  - 저장 형태는 메모의 한 종류(notes.origin = 'meeting'): 권한·철회·삭제·AI 참고 끄기·조용한 다시 쓰기·출처 비노출
//    규칙을 그대로 따른다. 대화에서는 "회의 기록"과 날짜를 붙여 모델에 건네, 개인 생각보다 회의에서 정한 것을,
//    오래된 회의보다 최근 회의를 우선하게 한다(chat.ts, prompts.ts).
//  - 고치기·철회·삭제는 쓴 사람만 할 수 있다(다른 팀원은 읽기만).
import type { PoolClient } from "pg";
import { requireMembership } from "./access.ts";
import { audit, getPool, withTx } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";
import { contentHash, invalidateAdviceForNote } from "./notes.ts";
import { bool, text } from "./validate.ts";

const MAX_MEETING = 10_000;

function meetingDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw badRequest("회의 날짜 형식이 올바르지 않습니다 (예: 2026-11-07).");
  return value;
}

type MeetingInput = { title: unknown; date: unknown; text: unknown; allowExternalAi?: unknown };

function parse(input: MeetingInput) {
  return {
    title: text(input.title, "회의 제목", { min: 1, max: 200 }),
    date: meetingDate(input.date),
    body: text(input.text, "회의 내용", { min: 1, max: MAX_MEETING }),
  };
}

async function insertVersion(tx: PoolClient, noteId: string, teamId: string, version: number, title: string, body: string, userId: string) {
  const v = await tx.query(
    `insert into note_versions (note_id, team_id, version, raw_text, content_hash, intent_state, confirmed_by, confirmed_at,
                                search_text, index_state)
     values ($1, $2, $3, $4, $5, 'raw_only', $6, now(), $7, 'ready') returning id`,
    [noteId, teamId, version, body, contentHash(body, null), userId, `${title}\n${body}`],
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
    const versionId = await insertVersion(tx, noteId, teamId, 1, m.title, m.body, userId);
    await tx.query("update notes set share_state = 'shared', current_version_id = $1, updated_at = now() where id = $2", [versionId, noteId]);
    await audit(tx, userId, "meeting.create", noteId, { allowExternalAi });
    return { noteId, versionId };
  });
}

/** 회의록 고치기(쓴 사람만). 제목·내용이 바뀌면 새 버전을 만들고, 이전 버전을 반영한 답변은 조용히 다시 쓰이게 한다. */
export async function updateMeeting(userId: string, noteId: string, input: MeetingInput) {
  const m = parse(input);
  return withTx(async (tx) => {
    const r = await tx.query(
      `select n.team_id, n.author_id, n.origin, n.title, n.meeting_date::text as meeting_date, n.share_state, v.raw_text,
              (select max(version) from note_versions x where x.note_id = n.id) as latest
       from notes n join note_versions v on v.id = n.current_version_id
       where n.id = $1 for update of n`,
      [noteId],
    );
    const n = r.rows[0];
    if (!n || n.origin !== "meeting" || n.author_id !== userId) throw notFound();
    await requireMembership(tx, userId, n.team_id);
    const contentChanged = n.title !== m.title || n.raw_text !== m.body;
    let invalidated = 0;
    if (contentChanged) {
      const versionId = await insertVersion(tx, noteId, n.team_id, Number(n.latest) + 1, m.title, m.body, userId);
      await tx.query("update notes set current_version_id = $1 where id = $2", [versionId, noteId]);
      invalidated = await invalidateAdviceForNote(tx, noteId);
    }
    await tx.query("update notes set title = $2, meeting_date = $3, updated_at = now() where id = $1", [noteId, m.title, m.date]);
    await audit(tx, userId, "meeting.update", noteId, { contentChanged, invalidated });
    return { noteId, contentChanged };
  });
}

/** 회의록 목록: 공유 중인 것 + 내가 쓰고 철회한 것. 최근 회의부터. */
export async function listMeetings(userId: string, teamId: string) {
  const db = getPool();
  await requireMembership(db, userId, teamId);
  const r = await db.query(
    `select n.id, n.title, n.meeting_date::text as date, n.share_state, n.allow_external_ai, n.updated_at,
            n.author_id = $2 as is_author, u.display_name as author_name, v.id as version_id, v.raw_text
     from notes n
     join users u on u.id = n.author_id
     join note_versions v on v.id = n.current_version_id
     where n.team_id = $1 and n.origin = 'meeting'
       and (n.share_state = 'shared' or (n.author_id = $2 and n.share_state = 'withdrawn'))
     order by n.meeting_date desc, n.created_at desc`,
    [teamId, userId],
  );
  return r.rows.map((x) => ({
    id: x.id as string,
    versionId: x.version_id as string,
    title: x.title as string,
    date: x.date as string,
    text: x.raw_text as string,
    state: x.share_state as "shared" | "withdrawn",
    allowExternalAi: x.allow_external_ai as boolean,
    isAuthor: x.is_author as boolean,
    authorName: x.author_name as string,
    updatedAt: x.updated_at,
  }));
}
