import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import { validateChatOutput } from "../src/lib/ai/validate-output.ts";
import { askInProject, listChat } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { listMemos, reviseShared, shareSummary, summarizeMemos } from "../src/lib/memos.ts";
import { createNote, deleteNote, withdrawNote } from "../src/lib/notes.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

const EXP = "두 실험은 측정 조건이 달라 보임(1차 22도, 2차 26도). 숫자만 비교하면 오해할 수도";
const ROOM = "회의실 예약 목요일 3시로 바꿈";

/** 지식 중 '실험'이 들어간 것만 반영했다고 밝히고, 답변에 번호를 흘리는 제공자 */
const leaky = () =>
  new FakeProvider({
    chat: (i) => {
      const used = i.knowledge.filter((k) => k.text.includes("실험")).map((k) => k.ref);
      return { answer: `그래프는 축을 맞추세요. 온도 조건이 달랐다는 점(${used.join(", ")})을 같이 적으면 좋습니다.`, used_refs: [...used, "N99"] };
    },
  });

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const exp = await shareSummary(alice, team.id, { text: EXP });
  const room = await shareSummary(alice, team.id, { text: ROOM });
  const project = await createTask(bob, team.id, { title: "실험 결과 발표", purpose: "두 실험 비교", audience: "비전공자" });
  return { alice, bob, teamId: team.id, exp, room, projectId: project.id as string };
}

describe("프로젝트 대화", () => {
  it("관련 팀 지식이 없어도 항상 답한다", async () => {
    const alice = await makeUser("alice");
    const team = await createTeam(alice, "빈 팀");
    const p = await createTask(alice, team.id, { title: "발표 준비" });
    const t = await askInProject(alice, p.id, { question: "첫 장은 어떻게 시작할까?" }, new FakeProvider());
    expect(t.status).toBe("ok");
    expect(t.answer).toBeTruthy();
  });

  it("공유된 지식만 모델에 가고, 답변에는 번호를 드러내지 않는다", async () => {
    const s = await setup();
    await createNote(s.alice, s.teamId, { rawText: "아직 나만 보는 메모: 비밀 계획" }); // 공유 전 개인 메모
    const rec = recording(leaky());
    const t = await askInProject(s.bob, s.projectId, { question: "두 실험 그래프를 어떻게 그릴까?" }, rec.provider);
    expect(t.status).toBe("ok");
    const sent = rec.calls.chat[0]!.knowledge.map((k) => k.text);
    expect(sent).toContain(EXP);
    expect(sent.join(" ")).not.toContain("비밀 계획");
    expect(JSON.stringify(rec.calls.chat[0])).not.toMatch(/alice|bob|@example/);
    expect(t.answer).not.toMatch(/\bN\d+\b/);
    // 실제로 반영한 것만 내부에 기록 (지어낸 N99 는 버림)
    const ev = await getPool().query("select evidence_version_ids from advice_items where request_id = $1", [t.id]);
    expect(ev.rows[0].evidence_version_ids).toEqual([s.exp.versionId]);
  });

  it("AI 참고를 허용하지 않은 공유 지식과 다른 팀 지식은 모델에 가지 않는다", async () => {
    const s = await setup();
    await shareSummary(s.alice, s.teamId, { text: "AI에 보내지 말 것: 실험 장비 위치", allowExternalAi: false });
    const other = await makeUser("carol");
    const t2 = await createTeam(other, "B팀");
    await shareSummary(other, t2.id, { text: "다른 팀의 실험 비밀" });
    const rec = recording(leaky());
    await askInProject(s.bob, s.projectId, { question: "실험 정리" }, rec.provider);
    const sent = rec.calls.chat[0]!.knowledge.map((k) => k.text).join(" ");
    expect(sent).not.toContain("장비 위치");
    expect(sent).not.toContain("다른 팀");
  });

  it("반영한 지식을 철회하면 그 답변만 숨기고, 반영하지 않은 지식의 철회는 영향이 없다", async () => {
    const s = await setup();
    const used = await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    const unused = await askInProject(s.bob, s.projectId, { question: "발표 순서" }, new FakeProvider({ chat: () => ({ answer: "결론부터", used_refs: [] }) }));
    await withdrawNote(s.alice, s.room.noteId); // 아무 답변도 반영하지 않은 지식
    let turns = await listChat(s.bob, s.projectId);
    expect(turns.map((t) => t.hidden)).toEqual([false, false]);
    await withdrawNote(s.alice, s.exp.noteId);
    turns = await listChat(s.bob, s.projectId);
    expect(turns.find((t) => t.id === used.id)).toMatchObject({ hidden: true, answer: null });
    expect(turns.find((t) => t.id === unused.id)).toMatchObject({ hidden: false, answer: "결론부터" });
  });

  it("반영한 지식을 삭제하면 답변 본문을 DB 에서 지운다", async () => {
    const s = await setup();
    const t = await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    await deleteNote(s.alice, s.exp.noteId);
    const r = await getPool().query("select body, purged from advice_items where request_id = $1", [t.id]);
    expect(r.rows[0]).toMatchObject({ body: "", purged: true });
  });

  it("이전 대화를 이어서 건네고, 숨겨진 답변은 건네지 않는다", async () => {
    const s = await setup();
    await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    await askInProject(s.bob, s.projectId, { question: "제목은?" }, new FakeProvider({ chat: () => ({ answer: "짧게", used_refs: [] }) }));
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "다음은?" }, rec.provider);
    expect(rec.calls.chat[0]!.history.map((h) => h.question)).toEqual(["실험 그래프", "제목은?"]);
    await withdrawNote(s.alice, s.exp.noteId);
    const rec2 = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "또?" }, rec2.provider);
    expect(rec2.calls.chat[0]!.history.map((h) => h.question)).toEqual(["제목은?", "다음은?"]);
  });

  it("대화는 묻는 사람에게만 보인다", async () => {
    const s = await setup();
    const t = await askInProject(s.bob, s.projectId, { question: "실험" }, leaky());
    expect(await listChat(s.alice, s.projectId)).toEqual([]);
    const other = await makeUser("carol");
    await expect(listChat(other, s.projectId)).rejects.toMatchObject({ status: 404 });
    expect((await listChat(s.bob, s.projectId)).map((x) => x.id)).toEqual([t.id]);
  });

  it("AI 가 연결되지 않으면 요청을 거부한다(지어낸 답을 만들지 않음)", async () => {
    const s = await setup();
    await expect(askInProject(s.bob, s.projectId, { question: "실험" }, noAiProvider)).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("모델 오류는 실패로 기록된다", async () => {
    const s = await setup();
    const t = await askInProject(s.bob, s.projectId, { question: "실험" }, new FakeProvider({ chat: () => ({ nope: 1 }) }));
    expect(t).toMatchObject({ status: "failed", error: "invalid_ai_output", answer: null });
  });

  it("답변 검증: 번호 흔적을 지우고, 건네지 않은 번호는 버린다", () => {
    const v = validateChatOutput({ answer: "온도가 달랐어요 (N1). [N2] 참고", used_refs: ["N1", "N7", 3] }, new Set(["N1", "N2"]));
    expect(v.answer).toBe("온도가 달랐어요 . 참고");
    expect(v.used).toEqual(["N1"]);
  });
});

describe("메모하기 → 메모 보기 → 정리 → 공유", () => {
  it("메모는 나만 보고, 고른 메모만 AI 정리에 간다", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const team = await createTeam(alice, "A팀");
    await joinTeam(bob, team.inviteCode);
    const m1 = await createNote(alice, team.id, { rawText: "1차 22도, 2차 26도" });
    const m2 = await createNote(alice, team.id, { rawText: "표본 12개뿐" });
    await createNote(alice, team.id, { rawText: "고르지 않은 메모" });
    expect((await listMemos(bob, team.id)).mine).toEqual([]);
    expect((await listMemos(alice, team.id)).mine).toHaveLength(3);

    const rec = recording(new FakeProvider({ summarize: () => ({ text: "- 1차 22도, 2차 26도\n- 표본 12개뿐" }) }));
    const s = await summarizeMemos(alice, team.id, { noteIds: [m1.noteId, m2.noteId] }, rec.provider);
    expect(rec.calls.summarize[0]!.memos).toEqual(["1차 22도, 2차 26도", "표본 12개뿐"]);
    expect(s.warnings).toEqual([]);
    // 남의 메모로는 정리할 수 없다
    await expect(summarizeMemos(bob, team.id, { noteIds: [m1.noteId] }, new FakeProvider())).rejects.toMatchObject({ status: 404 });

    // 작성자가 고친 내용 그대로 공유된다
    const shared = await shareSummary(alice, team.id, { text: "온도 22/26도, 표본 12개", sourceNoteIds: [m1.noteId, m2.noteId] });
    const forBob = await listMemos(bob, team.id);
    expect(forBob.shared.map((x) => x.text)).toEqual(["온도 22/26도, 표본 12개"]);
    const mine = (await listMemos(alice, team.id)).mine;
    expect(mine.filter((m) => m.inShared).map((m) => m.id).sort()).toEqual([m1.noteId, m2.noteId].sort());

    // 고쳐서 다시 공유
    await reviseShared(alice, shared.noteId, { text: "온도 22/26도, 표본 12개(오차 큼)" });
    expect((await listMemos(bob, team.id)).shared.map((x) => x.text)).toEqual(["온도 22/26도, 표본 12개(오차 큼)"]);
    // 개인 메모를 정리 없이 바로 공유하는 경로는 막는다
    await expect(reviseShared(alice, m1.noteId, { text: "바로 공유" })).rejects.toMatchObject({ status: 404 });
  });

  it("AI 정리 결과에 원문에 없는 숫자가 들어가면 경고한다", async () => {
    const alice = await makeUser("alice");
    const team = await createTeam(alice, "A팀");
    const m = await createNote(alice, team.id, { rawText: "표본 12개" });
    const s = await summarizeMemos(alice, team.id, { noteIds: [m.noteId] }, new FakeProvider({ summarize: () => ({ text: "표본 15개" }) }));
    expect(s.warnings.join(" ")).toContain("15");
  });
});
