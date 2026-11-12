// 2026-11-12 점검에서 재현한 결함의 회귀 테스트 (docs/보안_점검.md §21)
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { askInProject } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { route } from "../src/lib/http.ts";
import { createMeeting, listMeetings, updateMeeting } from "../src/lib/meetings.ts";
import { reviseShared, shareSummary } from "../src/lib/memos.ts";
import { confirmVersion, editNote, withdrawNote } from "../src/lib/notes.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, getTeam, joinTeam, leaveTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

const plain = () =>
  new FakeProvider({ chat: () => ({ answer: "답변입니다", used_refs: [] }), recap: (i) => ({ summary: `요약 ${i.turns.length}` }) });

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const project = await createTask(bob, team.id, { title: "본선 발표 준비" });
  return { alice, bob, teamId: team.id, inviteCode: team.inviteCode, projectId: project.id as string };
}

describe("지식이 바뀐 뒤의 대화 기억", () => {
  it("철회 뒤에도 새 답변은 이어지는 대화에 들어가고, 요약은 3턴에 한 번만 만든다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "슬라이드는 5장 이내" });
    await shareSummary(s.alice, s.teamId, { text: "데모는 녹화 영상으로" });
    for (let i = 1; i <= 8; i++) await askInProject(s.bob, s.projectId, { question: `전 ${i}` }, plain());
    await withdrawNote(s.alice, memo.noteId);

    let recaps = 0;
    const answered: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const rec = recording(plain());
      await askInProject(s.bob, s.projectId, { question: `후 ${i}` }, rec.provider);
      recaps += rec.calls.recap.length;
      answered.push(rec.calls.chat[0]!.history.slice(-6).filter((t) => t.answer).length); // 최근 6턴 기준
    }
    // 철회 뒤의 답변은 철회된 지식을 받지 않았으므로 한 턴씩 대화에 돌아온다
    expect(answered.slice(0, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(answered.slice(7)).toEqual([6, 6, 6, 6, 6]);
    // 철회 직후 1회 다시 만들고, 그 뒤로는 밀려난 턴이 3개 쌓일 때마다 1회
    expect(recaps).toBeLessThanOrEqual(5);
    // 요약의 입력 기록에는 지금 쓸 수 있는 지식만 남는다 (철회된 지식이 남으면 요약이 매번 버려진다)
    const m = await getPool().query(
      `select coalesce(bool_and(n.current_version_id = v.id and n.share_state = 'shared'), true) as live
       from chat_memories c, unnest(c.input_version_ids) e(id)
       join note_versions v on v.id = e.id join notes n on n.id = v.note_id`,
    );
    expect(m.rows[0].live).toBe(true);
  });
});

describe("최근 대화와 요약 사이의 공백", () => {
  it("최근 6턴에서 밀려났지만 아직 요약되지 않은 턴도 모델에 넘긴다", async () => {
    const s = await setup();
    for (let i = 1; i <= 8; i++) await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, plain()); // 8번째에서 1번 턴을 요약
    const seen: string[][] = [];
    const recaps: number[] = [];
    for (let i = 9; i <= 11; i++) {
      const rec = recording(plain());
      await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, rec.provider);
      seen.push(rec.calls.chat[0]!.history.map((t) => `${t.question}${t.answer ? "" : "(답 없음)"}`));
      recaps.push(rec.calls.recap.length);
    }
    const q = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => `질문 ${from + k}`);
    expect(seen[0]).toEqual(q(2, 8)); // 2번 턴: 요약에도 최근 6턴에도 없던 턴
    expect(seen[1]).toEqual(q(2, 9));
    expect(seen[2]).toEqual(q(5, 10)); // 3턴이 쌓여 요약에 접어 넣었으므로 최근 6턴만
    expect(recaps).toEqual([0, 0, 1]);
  });

  it("그 턴이 받았던 지식이 철회되면 답변 없이 질문만 넘긴다", async () => {
    const s = await setup();
    for (let i = 1; i <= 8; i++) await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, plain());
    const memo = await shareSummary(s.alice, s.teamId, { text: "슬라이드는 5장 이내" });
    for (let i = 9; i <= 15; i++) await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, plain());
    await withdrawNote(s.alice, memo.noteId);
    // 16번째 질문: 최근 6턴은 10~15, 아직 요약되지 않은 턴은 8(메모가 생기기 전)·9(메모를 받은 턴)
    const rec = recording(plain());
    await askInProject(s.bob, s.projectId, { question: "질문 16" }, rec.provider);
    const h = rec.calls.chat[0]!.history;
    expect(h.map((t) => t.question).slice(0, 2)).toEqual(["질문 8", "질문 9"]);
    expect(h[0]!.answer).toBeTruthy();
    expect(h.slice(1).every((t) => t.answer === null)).toBe(true);
  });
});

describe("팀 다시 참여", () => {
  it("나갔던 팀장이 돌아오면 팀원으로 시작한다", async () => {
    const s = await setup();
    await leaveTeam(s.alice, s.teamId); // bob 이 팀장을 넘겨받는다
    await joinTeam(s.alice, s.inviteCode);
    const roles = Object.fromEntries((await getTeam(s.bob, s.teamId)).members.map((m) => [m.displayName, m.role]));
    expect(roles).toEqual({ bob: "lead", alice: "member" });
  });

  it("이미 팀원인 사람이 초대 코드를 다시 넣어도 아무것도 바뀌지 않는다", async () => {
    const s = await setup();
    const carol = await makeUser("carol");
    await joinTeam(carol, s.inviteCode);
    const before = (await getTeam(s.alice, s.teamId)).members.map((m) => `${m.displayName}:${m.role}`);
    await joinTeam(s.bob, s.inviteCode);
    await joinTeam(s.alice, s.inviteCode);
    expect((await getTeam(s.alice, s.teamId)).members.map((m) => `${m.displayName}:${m.role}`)).toEqual(before);
  });

  it("모두 나간 팀에 돌아오면 팀장이 된다 (팀장 없는 팀이 생기지 않는다)", async () => {
    const s = await setup();
    await leaveTeam(s.bob, s.teamId);
    await leaveTeam(s.alice, s.teamId);
    await joinTeam(s.bob, s.inviteCode);
    expect((await getTeam(s.bob, s.teamId)).members.map((m) => `${m.displayName}:${m.role}`)).toEqual(["bob:lead"]);
  });
});

describe("회의록은 메모 API 로 고칠 수 없다", () => {
  it("메모 수정·확정·고쳐서 다시 공유는 회의록에 404 이고, 회의록은 그대로 남는다", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "데모 회의", date: "2026-11-06", text: "데모는 녹화 영상으로" });
    await expect(editNote(s.alice, m.noteId, "바꿈")).rejects.toMatchObject({ status: 404 });
    await expect(reviseShared(s.alice, m.noteId, { text: "바꿈" })).rejects.toMatchObject({ status: 404 });
    await expect(confirmVersion(s.alice, m.noteId, m.versionId, { choice: "raw_only", expectedHash: "x" })).rejects.toMatchObject({ status: 404 });
    const seen = await listMeetings(s.bob, s.teamId);
    expect(seen).toEqual([expect.objectContaining({ id: m.noteId, version: 1, title: "데모 회의", date: "2026-11-06", text: "데모는 녹화 영상으로", state: "shared" })]);
    const v = await getPool().query("select title, meeting_date from note_versions where note_id = $1", [m.noteId]);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].title).toBe("데모 회의");
  });
});

describe("입력 검증", () => {
  it("달력에 없는 회의 날짜는 400", async () => {
    const s = await setup();
    for (const date of ["2026-02-30", "2026-13-01", "2026-04-31", "2025-02-29"]) {
      await expect(createMeeting(s.alice, s.teamId, { title: "회의", date, text: "내용" })).rejects.toMatchObject({ status: 400 });
    }
    const m = await createMeeting(s.alice, s.teamId, { title: "회의", date: "2028-02-29", text: "내용" }); // 윤년은 받는다
    await expect(updateMeeting(s.alice, m.noteId, { title: "회의", date: "2026-02-30", text: "내용" })).rejects.toMatchObject({ status: 400 });
  });

  it("Origin 이 주소 형식이 아니면(null 등) 500 이 아니라 403", async () => {
    const handler = route(async () => ({ ok: true }));
    const call = (origin: string | null) => {
      const headers = new Headers({ host: "localhost:3000", "content-type": "application/json" });
      if (origin !== null) headers.set("origin", origin);
      return handler(new Request("http://localhost:3000/api/x", { method: "POST", headers, body: "{}" }), { params: Promise.resolve({}) });
    };
    expect((await call("null")).status).toBe(403);
    expect((await call("not a url")).status).toBe(403);
    expect((await call("http://evil.example")).status).toBe(403);
    expect((await call(null)).status).toBe(403);
    expect((await call("http://localhost:3000")).status).toBe(200);
  });
});
