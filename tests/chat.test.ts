import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import { sourceLeaks, validateChatOutput } from "../src/lib/ai/validate-output.ts";
import { askInProject, listChat, refreshStale } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { listMemos, reviseShared, setAiReference, shareSummary, summarizeMemos } from "../src/lib/memos.ts";
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

  it("반영한 지식을 철회하면 그 답변만 '다시 쓸 답변'이 되고, 다시 열면 출처 표시 없이 새로 쓴다", async () => {
    const s = await setup();
    const used = await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    const unused = await askInProject(s.bob, s.projectId, { question: "발표 순서" }, new FakeProvider({ chat: () => ({ answer: "결론부터", used_refs: [] }) }));
    await withdrawNote(s.alice, s.room.noteId); // 아무 답변도 반영하지 않은 지식
    let turns = await listChat(s.bob, s.projectId);
    expect(turns.map((t) => t.stale)).toEqual([false, false]);
    await withdrawNote(s.alice, s.exp.noteId);
    turns = await listChat(s.bob, s.projectId);
    // 화면에는 사유 없이 '작성 중'으로만 보인다
    expect(turns.find((t) => t.id === used.id)).toMatchObject({ stale: true, status: "pending", answer: null, error: null });
    expect(turns.find((t) => t.id === unused.id)).toMatchObject({ stale: false, answer: "결론부터" });

    const rec = recording(new FakeProvider({ chat: () => ({ answer: "축과 단위를 맞추세요.", used_refs: [] }) }));
    turns = await refreshStale(s.bob, s.projectId, rec.provider);
    expect(turns.find((t) => t.id === used.id)).toMatchObject({ stale: false, status: "ok", answer: "축과 단위를 맞추세요." });
    // 다시 쓸 때 철회된 지식은 건네지 않고, 같은 질문으로 다시 묻는다. "쓰지 마" 같은 지시도 없다
    expect(rec.calls.chat[0]!.question).toBe("실험 그래프");
    expect(rec.calls.chat[0]!.knowledge.map((k) => k.text).join(" ")).not.toContain("측정 조건");
    expect(JSON.stringify(rec.calls.chat[0])).not.toMatch(/쓰지 마|참조하지|철회/);
  });

  it("반영한 지식을 삭제하면 답변 본문을 바로 지우고, 다시 열면 새로 쓴다", async () => {
    const s = await setup();
    const t = await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    await deleteNote(s.alice, s.exp.noteId);
    const r = await getPool().query("select body, purged from advice_items where request_id = $1", [t.id]);
    expect(r.rows[0]).toMatchObject({ body: "", purged: true });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ stale: true, answer: null });
    const after = await refreshStale(s.bob, s.projectId, new FakeProvider({ chat: () => ({ answer: "새 답변", used_refs: [] }) }));
    expect(after[0]).toMatchObject({ stale: false, answer: "새 답변" });
    const rows = await getPool().query("select body from advice_items where request_id = $1", [t.id]);
    expect(rows.rows.map((x) => x.body)).toEqual(["새 답변"]);
  });

  it("AI 참고를 끄면 그 지식은 더 이상 모델에 가지 않고, 반영했던 답변은 다시 쓴다", async () => {
    const s = await setup();
    const t = await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    await setAiReference(s.alice, s.exp.noteId, { allowExternalAi: false });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: true });
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "실험 정리" }, rec.provider);
    expect(rec.calls.chat[0]!.knowledge.map((k) => k.text).join(" ")).not.toContain("측정 조건");
    // 다른 사람은 바꿀 수 없다
    await expect(setAiReference(s.bob, s.exp.noteId, { allowExternalAi: true })).rejects.toMatchObject({ status: 404 });
  });

  it("다시 쓰기에 실패해도 예전 답변이 되살아나지 않는다", async () => {
    const s = await setup();
    await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, leaky());
    await withdrawNote(s.alice, s.exp.noteId);
    const after = await refreshStale(s.bob, s.projectId, new FakeProvider({ chat: () => ({ nope: true }) }));
    expect(after[0]).toMatchObject({ status: "failed", answer: null, stale: false });
    expect(JSON.stringify(after)).not.toContain("온도 조건");
  });

  it("이전 대화를 이어서 건네되, 지금 쓸 수 없는 지식이 넘어갔던 턴은 질문만 건넨다 (반영을 밝히지 않았어도)", async () => {
    const s = await setup();
    // 반영 사실을 밝히지 않고 지식을 쓴 답변
    const quiet = new FakeProvider({ chat: () => ({ answer: "22도와 26도는 다른 조건이에요", used_refs: [] }) });
    await askInProject(s.bob, s.projectId, { question: "실험 그래프" }, quiet);
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "다음은?" }, rec.provider);
    expect(rec.calls.chat[0]!.history).toEqual([{ question: "실험 그래프", answer: "22도와 26도는 다른 조건이에요" }]);

    await withdrawNote(s.alice, s.exp.noteId);
    // 화면의 답변은 그대로 (반영을 밝히지 않았으므로 다시 쓰지 않음)
    expect((await listChat(s.bob, s.projectId)).map((t) => t.stale)).toEqual([false, false]);
    const rec2 = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "또?" }, rec2.provider);
    // 철회된 지식이 넘어갔던 턴은 답변 없이 질문만
    expect(rec2.calls.chat[0]!.history).toEqual([{ question: "실험 그래프", answer: null }, { question: "다음은?", answer: null }]);
    expect(JSON.stringify(rec2.calls.chat[0]!.history)).not.toContain("22도");
  });

  it("답변에 출처 표현이 나오면 한 번 다시 쓰게 하고, 그래도 나오면 그 문장을 뺀다", async () => {
    const s = await setup();
    let calls = 0;
    const once = new FakeProvider({ chat: (i) => (calls++ === 0 ? { answer: "공유된 내용에 따르면 22도예요.", used_refs: [] } : { answer: i.retryNote ? "온도가 22도예요." : "?", used_refs: [] }) });
    const t1 = await askInProject(s.bob, s.projectId, { question: "온도?" }, once);
    expect(calls).toBe(2);
    expect(t1.answer).toBe("온도가 22도예요.");

    const stubborn = new FakeProvider({ chat: () => ({ answer: "축을 맞추세요. 팀원이 남긴 기록을 보면 12개예요.\n- 단위도 적으세요", used_refs: [] }) });
    const t2 = await askInProject(s.bob, s.projectId, { question: "그래프?" }, stubborn);
    expect(t2.answer).toBe("축을 맞추세요.\n- 단위도 적으세요");

    const allLeak = new FakeProvider({ chat: () => ({ answer: "메모에 따르면 그래요.", used_refs: [] }) });
    const t3 = await askInProject(s.bob, s.projectId, { question: "그래?" }, allLeak);
    expect(t3).toMatchObject({ status: "failed", answer: null });

    // 질문에 그 낱말이 있으면 검사하지 않는다
    const memoApp = new FakeProvider({ chat: () => ({ answer: "메모 앱은 가벼운 것이 좋아요.", used_refs: [] }) });
    const t4 = await askInProject(s.bob, s.projectId, { question: "메모 앱 추천해 줘" }, memoApp);
    expect(t4.answer).toBe("메모 앱은 가벼운 것이 좋아요.");
  });

  it("출처 표현 검사기", () => {
    expect(sourceLeaks("공유된 내용에 따르면 22도입니다.")).not.toEqual([]);
    expect(sourceLeaks("자료에 따르면 그렇습니다.")).not.toEqual([]);
    expect(sourceLeaks("팀원들이 남긴 의견처럼")).not.toEqual([]);
    expect(sourceLeaks("22도와 26도로 조건이 달라요. 표본 12개면 오차가 커요.")).toEqual([]);
    expect(sourceLeaks("메모 앱은 노션", "메모 앱 추천")).toEqual([]);
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
