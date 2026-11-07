import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { sourceLeaks } from "../src/lib/ai/validate-output.ts";
import { askInProject, listChat, refreshStale } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { deleteAccount } from "../src/lib/account.ts";
import { compactDiff, diffLines } from "../src/lib/diff.ts";
import { createMeeting, listMeetings, manageMeeting, meetingHistory, updateMeeting } from "../src/lib/meetings.ts";
import { listMemos, setAiReference, shareSummary } from "../src/lib/memos.ts";
import { deleteNote, withdrawNote } from "../src/lib/notes.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

const DECISION = "결정한 것:\n- 발표는 서준이 맡는다\n- 데모는 녹화 영상으로 한다\n\n아직 정하지 못한 것:\n- 슬라이드 장수";

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const project = await createTask(bob, team.id, { title: "LED 실험 발표" });
  return { alice, bob, teamId: team.id, projectId: project.id as string };
}

/** 회의 기록을 반영했다고 밝히는 제공자 */
const usesMeetings = () =>
  new FakeProvider({ chat: (i) => ({ answer: "데모는 녹화 영상으로 준비하세요.", used_refs: i.knowledge.filter((k) => k.meeting).map((k) => k.ref) }) });

describe("회의록", () => {
  it("쓰면 바로 팀에 공유되고, 팀원 모두 볼 수 있다 (메모 보기와는 따로)", async () => {
    const s = await setup();
    await createMeeting(s.alice, s.teamId, { title: "발표 구성 회의", date: "2026-11-05", text: DECISION });
    const forBob = await listMeetings(s.bob, s.teamId);
    expect(forBob).toEqual([expect.objectContaining({ title: "발표 구성 회의", date: "2026-11-05", text: DECISION, isAuthor: false, authorName: "alice" })]);
    expect((await listMemos(s.bob, s.teamId)).shared).toEqual([]);
    const other = await makeUser("carol");
    await expect(listMeetings(other, s.teamId)).rejects.toMatchObject({ status: 404 });
  });

  it("입력 검사: 날짜 형식, 길이 (10000자까지)", async () => {
    const s = await setup();
    await expect(createMeeting(s.alice, s.teamId, { title: "회의", date: "11/05", text: "내용" })).rejects.toMatchObject({ status: 400 });
    await expect(createMeeting(s.alice, s.teamId, { title: "", date: "2026-11-05", text: "내용" })).rejects.toMatchObject({ status: 400 });
    const long = await createMeeting(s.alice, s.teamId, { title: "긴 회의", date: "2026-11-05", text: "가".repeat(10000) });
    expect(long.noteId).toBeTruthy();
    await expect(createMeeting(s.alice, s.teamId, { title: "너무 긴 회의", date: "2026-11-05", text: "가".repeat(10001) })).rejects.toMatchObject({ status: 400 });
  });

  it("대화할 때 회의 기록임과 날짜를 붙여 모델에 건넨다 (작성자 정보 없이)", async () => {
    const s = await setup();
    await createMeeting(s.alice, s.teamId, { title: "발표 구성 회의", date: "2026-11-05", text: DECISION });
    await shareSummary(s.alice, s.teamId, { text: "데모는 실시간으로 하면 좋겠음" });
    const rec = recording(usesMeetings());
    const t = await askInProject(s.bob, s.projectId, { question: "데모는 어떻게 해?" }, rec.provider);
    expect(t.status).toBe("ok");
    const k = rec.calls.chat[0]!.knowledge;
    expect(k.find((x) => x.meeting)).toMatchObject({ meeting: { title: "발표 구성 회의", date: "2026-11-05" }, text: DECISION });
    expect(k.find((x) => !x.meeting)).toMatchObject({ text: "데모는 실시간으로 하면 좋겠음", meeting: null });
    expect(JSON.stringify(rec.calls.chat[0])).not.toMatch(/alice|@example/);
  });

  it("제목으로도 찾고, 회의록을 고치면(날짜 포함) 반영했던 답변은 조용히 다시 쓴다", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "데모 방식 회의", date: "2026-11-05", text: "녹화 영상으로 하기로 함" });
    const t = await askInProject(s.bob, s.projectId, { question: "데모 방식?" }, usesMeetings());
    await updateMeeting(s.alice, m.noteId, { title: "데모 방식 회의", date: "2026-11-05", text: "녹화 영상으로 하기로 함" }); // 바뀐 것 없음
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: false });
    await updateMeeting(s.alice, m.noteId, { title: "데모 방식 회의", date: "2026-11-06", text: "녹화 영상으로 하기로 함" });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: true });
    await refreshStale(s.bob, s.projectId, usesMeetings());
    await updateMeeting(s.alice, m.noteId, { title: "데모 방식 회의", date: "2026-11-06", text: "실시간 데모로 바꿈" });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: true });
    expect((await listMeetings(s.bob, s.teamId))[0]).toMatchObject({ text: "실시간 데모로 바꿈", date: "2026-11-06" });
    // 다른 팀 사람은 고칠 수 없다
    const other = await makeUser("carol");
    await expect(updateMeeting(other, m.noteId, { title: "x", date: "2026-11-06", text: "y" })).rejects.toMatchObject({ status: 404 });
  });

  it("철회·AI 참고 끄기·삭제는 메모와 같은 규칙을 따른다", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "회의", date: "2026-11-05", text: DECISION });
    const ask = async () => {
      const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
      await askInProject(s.bob, s.projectId, { question: "데모?" }, rec.provider);
      return rec.calls.chat[0]!.knowledge.length;
    };
    expect(await ask()).toBe(1);
    await setAiReference(s.alice, m.noteId, { allowExternalAi: false });
    expect(await ask()).toBe(0);
    await setAiReference(s.alice, m.noteId, { allowExternalAi: true });
    await withdrawNote(s.alice, m.noteId);
    expect(await ask()).toBe(0);
    expect(await listMeetings(s.bob, s.teamId)).toEqual([]);
    expect((await listMeetings(s.alice, s.teamId))[0]).toMatchObject({ state: "withdrawn" });
    await deleteNote(s.alice, m.noteId);
    const left = await getPool().query("select count(*)::int as c from note_versions where note_id = $1", [m.noteId]);
    expect(left.rows[0].c).toBe(0);
  });

  it("회의를 출처로 드러내는 표현을 잡는다 (회의를 직접 물으면 허용)", () => {
    expect(sourceLeaks("회의에서 정한 대로 녹화 영상으로 하세요.")).not.toEqual([]);
    expect(sourceLeaks("회의록에 따르면 서준이 발표해요.")).not.toEqual([]);
    expect(sourceLeaks("지난 회의 내용을 보면 그래요.")).not.toEqual([]);
    expect(sourceLeaks("데모는 녹화 영상으로 준비하세요.")).toEqual([]);
    expect(sourceLeaks("지난 회의에서 정한 것은 두 가지예요.", "지난 회의에서 뭐 정했지?")).toEqual([]);
  });

  it("팀원 누구나 고칠 수 있고, 수정 기록에 누가 무엇을 고쳤는지 남는다", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "발표 회의", date: "2026-11-05", text: "발표자: 지민\n데모: 실시간" });
    const v1 = (await listMeetings(s.bob, s.teamId))[0]!;
    await updateMeeting(s.bob, m.noteId, { title: "발표 회의", date: "2026-11-05", text: "발표자: 지민\n데모: 녹화", baseVersionId: v1.versionId });
    const v2 = (await listMeetings(s.alice, s.teamId))[0]!;
    await updateMeeting(s.alice, m.noteId, { title: "발표 구성 회의", date: "2026-11-06", text: "발표자: 지민\n데모: 녹화", baseVersionId: v2.versionId });
    const now = (await listMeetings(s.bob, s.teamId))[0]!;
    expect(now).toMatchObject({ title: "발표 구성 회의", date: "2026-11-06", version: 3, authorName: "alice", lastEditedBy: "alice", canManage: false });
    const h = await meetingHistory(s.bob, m.noteId);
    expect(h.map((v) => [v.version, v.editorName, v.title, v.date])).toEqual([
      [3, "alice", "발표 구성 회의", "2026-11-06"],
      [2, "bob", "발표 회의", "2026-11-05"],
      [1, "alice", "발표 회의", "2026-11-05"],
    ]);
    expect(diffLines(h[2]!.text, h[1]!.text)).toEqual([
      { op: "same", text: "발표자: 지민" }, { op: "del", text: "데모: 실시간" }, { op: "add", text: "데모: 녹화" },
    ]);
    // 아무것도 안 바꾸면 버전을 늘리지 않는다
    const r = await updateMeeting(s.bob, m.noteId, { title: "발표 구성 회의", date: "2026-11-06", text: "발표자: 지민\n데모: 녹화" });
    expect(r.changed).toBe(false);
  });

  it("동시에 고치면 나중에 저장한 쪽은 앞사람의 수정을 덮어쓰지 못한다", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "회의", date: "2026-11-05", text: "처음" });
    const base = (await listMeetings(s.alice, s.teamId))[0]!.versionId;
    await updateMeeting(s.alice, m.noteId, { title: "회의", date: "2026-11-05", text: "alice 가 고침", baseVersionId: base });
    await expect(updateMeeting(s.bob, m.noteId, { title: "회의", date: "2026-11-05", text: "bob 이 고침", baseVersionId: base }))
      .rejects.toMatchObject({ status: 409 });
    expect((await listMeetings(s.bob, s.teamId))[0]!.text).toBe("alice 가 고침");
  });

  it("철회·삭제·AI 참고 끄기는 처음 쓴 사람이나 팀장만", async () => {
    const s = await setup();
    const carol = await makeUser("carol");
    const team = await getPool().query("select invite_code from teams where id = $1", [s.teamId]);
    await joinTeam(carol, team.rows[0].invite_code);
    const m = await createMeeting(s.bob, s.teamId, { title: "bob 의 회의록", date: "2026-11-05", text: "내용" });
    await expect(manageMeeting(carol, m.noteId, { action: "withdraw" })).rejects.toMatchObject({ status: 403 });
    await expect(manageMeeting(carol, m.noteId, { action: "delete" })).rejects.toMatchObject({ status: 403 });
    await manageMeeting(s.alice, m.noteId, { action: "ai", allowExternalAi: false }); // alice 는 팀장
    await manageMeeting(s.bob, m.noteId, { action: "withdraw" });
    expect(await listMeetings(carol, s.teamId)).toEqual([]);
    expect((await listMeetings(s.alice, s.teamId))[0]).toMatchObject({ state: "withdrawn", allowExternalAi: false });
    await manageMeeting(s.bob, m.noteId, { action: "share" });
    expect(await listMeetings(carol, s.teamId)).toHaveLength(1);
    await manageMeeting(s.alice, m.noteId, { action: "delete" });
    expect(await listMeetings(s.bob, s.teamId)).toEqual([]);
  });

  it("회원 탈퇴: 공유된 회의록은 남고(작성자·고친 사람은 '탈퇴한 사용자'), 철회해 둔 회의록과 다른 정보는 지운다", async () => {
    const s = await setup();
    const kept = await createMeeting(s.bob, s.teamId, { title: "남길 회의록", date: "2026-11-05", text: "데모는 녹화" });
    const v = (await listMeetings(s.bob, s.teamId))[0]!.versionId;
    await updateMeeting(s.bob, kept.noteId, { title: "남길 회의록", date: "2026-11-05", text: "데모는 녹화 영상", baseVersionId: v });
    const gone = await createMeeting(s.bob, s.teamId, { title: "철회한 회의록", date: "2026-11-04", text: "비공개" });
    await manageMeeting(s.bob, gone.noteId, { action: "withdraw" });
    await shareSummary(s.bob, s.teamId, { text: "bob 의 공유 메모" });

    await deleteAccount(s.bob, { password: "correct-horse-battery" });

    const list = await listMeetings(s.alice, s.teamId);
    expect(list).toEqual([expect.objectContaining({ title: "남길 회의록", text: "데모는 녹화 영상", authorName: "탈퇴한 사용자", lastEditedBy: "탈퇴한 사용자", canManage: true })]);
    expect((await meetingHistory(s.alice, kept.noteId)).map((h) => h.editorName)).toEqual(["탈퇴한 사용자", "탈퇴한 사용자"]);
    expect(await getPool().query("select 1 from notes where id = $1", [gone.noteId]).then((r) => r.rowCount)).toBe(0);
    expect((await listMemos(s.alice, s.teamId)).shared).toEqual([]);
    expect(await getPool().query("select 1 from users where id = $1", [s.bob]).then((r) => r.rowCount)).toBe(0);
    // AI 도 계속 참고한다
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.alice, s.projectId, { question: "데모?" }, rec.provider);
    expect(rec.calls.chat[0]!.knowledge.map((k) => k.text)).toContain("데모는 녹화 영상");
    // 남은 팀장은 고치거나 지울 수 있다
    await updateMeeting(s.alice, kept.noteId, { title: "남길 회의록", date: "2026-11-05", text: "데모는 녹화 영상 (확정)" });
  });

  it("줄 비교: 같은 줄이 길게 이어지면 접는다", () => {
    const before = ["a", "b", "c", "d", "e", "f"].join("\n");
    const after = ["a", "b", "c", "d", "e", "F"].join("\n");
    expect(compactDiff(diffLines(before, after))).toEqual([
      { op: "skip", count: 4 }, { op: "same", text: "e" }, { op: "del", text: "f" }, { op: "add", text: "F" },
    ]);
  });
});
