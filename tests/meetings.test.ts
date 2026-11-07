import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { sourceLeaks } from "../src/lib/ai/validate-output.ts";
import { askInProject, listChat } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { createMeeting, listMeetings, updateMeeting } from "../src/lib/meetings.ts";
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

  it("제목으로도 찾고, 회의 내용을 고치면 반영했던 답변은 조용히 다시 쓴다 (날짜만 바꾸면 그대로)", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "데모 방식 회의", date: "2026-11-05", text: "녹화 영상으로 하기로 함" });
    const t = await askInProject(s.bob, s.projectId, { question: "데모 방식?" }, usesMeetings());
    await updateMeeting(s.alice, m.noteId, { title: "데모 방식 회의", date: "2026-11-06", text: "녹화 영상으로 하기로 함" });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: false });
    await updateMeeting(s.alice, m.noteId, { title: "데모 방식 회의", date: "2026-11-06", text: "실시간 데모로 바꿈" });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: true });
    expect((await listMeetings(s.bob, s.teamId))[0]).toMatchObject({ text: "실시간 데모로 바꿈", date: "2026-11-06" });
    // 쓴 사람만 고칠 수 있다
    await expect(updateMeeting(s.bob, m.noteId, { title: "x", date: "2026-11-06", text: "y" })).rejects.toMatchObject({ status: 404 });
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
});
