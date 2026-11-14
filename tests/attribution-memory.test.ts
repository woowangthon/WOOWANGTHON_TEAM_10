import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import type { ChatInput } from "../src/lib/ai/types.ts";
import { citations, sourceLeaks } from "../src/lib/ai/validate-output.ts";
import { askInProject, listChat, refreshStale } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { createMeeting } from "../src/lib/meetings.ts";
import { shareSummary } from "../src/lib/memos.ts";
import { deleteNote, withdrawNote } from "../src/lib/notes.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const project = await createTask(bob, team.id, { title: "본선 발표 준비" });
  return { alice, bob, teamId: team.id, projectId: project.id as string };
}

/** 주어진 종류의 지식을 반영했다고 밝히고 answer 를 돌려주는 제공자 */
const citing = (answer: string, pick: (k: ChatInput["knowledge"][number]) => boolean) =>
  new FakeProvider({ chat: (i) => ({ answer, used_refs: i.knowledge.filter(pick).map((k) => k.ref) }) });

describe("출처 표시: 공개 메모·회의록은 밝히고, 'AI만 참고'는 숨긴다", () => {
  it("공개 메모를 반영했으면 '팀원이 공유한 메모에 따르면'을 그대로 둔다", async () => {
    const s = await setup();
    await shareSummary(s.alice, s.teamId, { text: "슬라이드는 5장 이내" });
    const answer = "팀원이 공유한 메모에 따르면 슬라이드는 5장 이내로 만들면 돼요.";
    let calls = 0;
    const p = new FakeProvider({ chat: (i) => (calls++, { answer, used_refs: i.knowledge.map((k) => k.ref) }) });
    const t = await askInProject(s.bob, s.projectId, { question: "슬라이드 몇 장?" }, p);
    expect(t.answer).toBe(answer);
    expect(calls).toBe(1); // 다시 쓰게 하지 않음
    expect(t.sources).toEqual([expect.objectContaining({ kind: "memo", text: "슬라이드는 5장 이내" })]);
  });

  it("회의록을 반영했으면 '11월 6일 회의에서'를 그대로 두고, 출처로 회의록을 보여준다", async () => {
    const s = await setup();
    await createMeeting(s.alice, s.teamId, { title: "데모 회의", date: "2026-11-06", text: "데모는 녹화 영상으로" });
    const answer = "11월 6일 회의에서 정한 대로 데모는 녹화 영상으로 준비하세요.";
    const t = await askInProject(s.bob, s.projectId, { question: "데모는?" }, citing(answer, (k) => !!k.meeting));
    expect(t.answer).toBe(answer);
    expect(t.sources).toEqual([expect.objectContaining({ kind: "meeting", title: "데모 회의", date: "2026-11-06" })]);
  });

  it("'AI만 참고' 정보만 반영했는데 메모를 출처로 말하면 다시 쓰게 하고, 화면 출처에도 넣지 않는다", async () => {
    const s = await setup();
    await shareSummary(s.alice, s.teamId, { text: "리허설은 금요일 저녁 7시", visibility: "ai_only" });
    let calls = 0;
    const p = new FakeProvider({
      chat: (i) => {
        calls++;
        const refs = i.knowledge.filter((k) => k.aiOnly).map((k) => k.ref);
        return i.retryNote ? { answer: "리허설은 금요일 저녁 7시예요.", used_refs: refs } : { answer: "팀원이 공유한 메모에 따르면 리허설은 금요일 저녁 7시예요.", used_refs: refs };
      },
    });
    const t = await askInProject(s.bob, s.projectId, { question: "리허설 언제?" }, p);
    expect(calls).toBe(2);
    expect(t.answer).toBe("리허설은 금요일 저녁 7시예요.");
    expect(t.sources).toEqual([]);
  });

  it("모델에 지식 종류를 나눠 건넨다 (팀 공유 메모 / 회의록 / private)", async () => {
    const s = await setup();
    await shareSummary(s.alice, s.teamId, { text: "공개 메모" });
    await shareSummary(s.alice, s.teamId, { text: "숨긴 메모", visibility: "ai_only" });
    await createMeeting(s.alice, s.teamId, { title: "회의", date: "2026-11-06", text: "회의 내용" });
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "정리해 줘" }, rec.provider);
    const k = rec.calls.chat[0]!.knowledge;
    expect(k.find((x) => x.text === "공개 메모")).toMatchObject({ aiOnly: false, meeting: null });
    // 다른 팀원의 'AI만 참고' 메모는 원문 없이 전달용 정리로 넘어간다 (tests/relay.test.ts)
    expect(k.find((x) => x.aiOnly)).toMatchObject({ aiOnly: true, text: "", mine: false });
    expect(k.some((x) => x.text === "숨긴 메모")).toBe(false);
    expect(k.find((x) => x.text === "회의 내용")).toMatchObject({ meeting: { date: "2026-11-06" } });
  });

  it("검사기: 반영한 종류의 출처만 허용", () => {
    const memoCite = "팀원이 공유한 메모에 따르면 5장이에요.";
    const meetingCite = "11월 6일 회의에서 정한 대로 녹화예요.";
    expect(sourceLeaks(memoCite, "", { memo: true })).toEqual([]);
    expect(sourceLeaks(memoCite, "", { meeting: true })).not.toEqual([]);
    expect(sourceLeaks(meetingCite, "", { meeting: true })).toEqual([]);
    expect(sourceLeaks(meetingCite, "", { memo: true })).not.toEqual([]);
    // 비공개 정보의 존재는 무엇을 반영했든 금지
    expect(sourceLeaks("비공개 메모라 말할 수 없어요.", "", { memo: true, meeting: true })).not.toEqual([]);
    expect(citations(memoCite)).toEqual({ memo: true, meeting: false });
  });
});

describe("사용자별 대화 기억", () => {
  const plain = (answer = "네") => new FakeProvider({ chat: () => ({ answer, used_refs: [] }) });

  it("최근 6턴 밖으로 밀려난 대화는 요약해 두고 다음 질문에 함께 건넨다", async () => {
    const s = await setup();
    await askInProject(s.bob, s.projectId, { question: "나는 서준이고 데모 영상 담당이야" }, plain("알겠어요"));
    for (let i = 1; i <= 6; i++) await askInProject(s.bob, s.projectId, { question: `잡담 ${i}` }, plain());
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }), recap: (i) => ({ summary: `요약: ${i.turns.map((t) => t.question).join(", ")}` }) }));
    await askInProject(s.bob, s.projectId, { question: "내가 맡은 게 뭐였지?" }, rec.provider);
    expect(rec.calls.recap).toHaveLength(1);
    expect(rec.calls.recap[0]!.turns.map((t) => t.question)).toEqual(["나는 서준이고 데모 영상 담당이야"]);
    const input = rec.calls.chat[0]!;
    expect(input.memory).toBe("요약: 나는 서준이고 데모 영상 담당이야");
    expect(input.history.map((h) => h.question)).toEqual(["잡담 1", "잡담 2", "잡담 3", "잡담 4", "잡담 5", "잡담 6"]);
    const row = await getPool().query("select summary from chat_memories where task_id = $1 and user_id = $2", [s.projectId, s.bob]);
    expect(row.rows[0].summary).toBe("요약: 나는 서준이고 데모 영상 담당이야");
  });

  it("요약은 몇 턴씩 모아서만 다시 만든다 (매 질문마다 부르지 않음)", async () => {
    const s = await setup();
    for (let i = 1; i <= 7; i++) await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, plain());
    const rec = recording(plain());
    await askInProject(s.bob, s.projectId, { question: "질문 8" }, rec.provider); // 처음 요약 (밀려난 1턴)
    await askInProject(s.bob, s.projectId, { question: "질문 9" }, rec.provider); // 밀려난 새 턴 1개: 아직 안 함
    await askInProject(s.bob, s.projectId, { question: "질문 10" }, rec.provider); // 2개
    expect(rec.calls.recap).toHaveLength(1);
    await askInProject(s.bob, s.projectId, { question: "질문 11" }, rec.provider); // 3개 모임 → 다시 요약
    expect(rec.calls.recap).toHaveLength(2);
    expect(rec.calls.recap[1]!.previous).toBeTruthy();
  });

  it("다른 팀원과 기억을 나누지 않는다", async () => {
    const s = await setup();
    await askInProject(s.bob, s.projectId, { question: "나는 서준이야" }, plain());
    for (let i = 1; i <= 6; i++) await askInProject(s.bob, s.projectId, { question: `잡담 ${i}` }, plain());
    await askInProject(s.bob, s.projectId, { question: "기억해?" }, plain());
    const rec = recording(plain());
    await askInProject(s.alice, s.projectId, { question: "내가 누구지?" }, rec.provider);
    expect(rec.calls.chat[0]!.memory ?? null).toBeNull();
    expect(rec.calls.chat[0]!.history).toEqual([]);
  });

  it("요약에 들어간 지식을 철회·삭제하면 기억을 바로 지우고, 다음엔 그 답변 없이 다시 요약한다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "리허설은 금요일 7시" });
    await askInProject(s.bob, s.projectId, { question: "리허설 언제?" }, citing("팀원이 공유한 메모에 따르면 금요일 7시예요.", () => true));
    for (let i = 1; i <= 6; i++) await askInProject(s.bob, s.projectId, { question: `잡담 ${i}` }, plain());
    await askInProject(s.bob, s.projectId, { question: "다음" }, plain());
    expect((await getPool().query("select 1 from chat_memories")).rowCount).toBe(1);

    await deleteNote(s.alice, memo.noteId);
    expect((await getPool().query("select 1 from chat_memories")).rowCount).toBe(0); // 즉시 삭제

    // 지운 지식에 기댄 답변은 다시 써야 하는 상태가 되고, 새로 만드는 기억에는 그 답변이 들어가지 않는다
    await refreshStale(s.bob, s.projectId, plain("다시 쓴 답"));
    const rec = recording(plain());
    await askInProject(s.bob, s.projectId, { question: "또" }, rec.provider);
    expect(JSON.stringify(rec.calls.recap)).not.toContain("금요일 7시");
    expect(JSON.stringify(rec.calls.chat[0])).not.toContain("금요일 7시");
  });

  it("철회해도 기억을 지운다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "슬라이드 5장" });
    for (let i = 1; i <= 8; i++) await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, plain());
    expect((await getPool().query("select 1 from chat_memories")).rowCount).toBe(1);
    await withdrawNote(s.alice, memo.noteId);
    expect((await getPool().query("select 1 from chat_memories")).rowCount).toBe(0);
  });

  it("요약에 실패해도 대화는 계속된다", async () => {
    const s = await setup();
    for (let i = 1; i <= 7; i++) await askInProject(s.bob, s.projectId, { question: `질문 ${i}` }, plain());
    const t = await askInProject(s.bob, s.projectId, { question: "질문 8" }, new FakeProvider({ chat: () => ({ answer: "답", used_refs: [] }), recap: () => ({ nope: 1 }) }));
    expect(t).toMatchObject({ status: "ok", answer: "답" });
    expect((await listChat(s.bob, s.projectId)).length).toBe(8);
  });
});

describe("질문한 사람", () => {
  it("본인 이름만 넘기고, 지식 작성자 이름은 넘기지 않는다", async () => {
    const s = await setup();
    await shareSummary(s.alice, s.teamId, { text: "데모 영상은 bob 이 맡기로 함" });
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "내가 할 일은?" }, rec.provider);
    const input = rec.calls.chat[0]!;
    expect(input.askerName).toBe("bob");
    expect(JSON.stringify(input.knowledge)).not.toContain("alice");
  });
});
