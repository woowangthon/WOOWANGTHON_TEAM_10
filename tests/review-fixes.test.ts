// 11/8 독립 검토에서 지적된 결함을 재현하고, 고친 뒤 동작을 고정한다.
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { askInProject, listChat } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { createMeeting, manageMeeting } from "../src/lib/meetings.ts";
import { setVisibility, shareSummary } from "../src/lib/memos.ts";
import { deleteNote, withdrawNote } from "../src/lib/notes.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

async function setup(projectInput: { title: string; purpose?: string } = { title: "본선 발표 준비" }) {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const project = await createTask(bob, team.id, projectInput);
  return { alice, bob, teamId: team.id, projectId: project.id as string };
}

/** 지식을 써서 답하지만 반영 번호는 밝히지 않는 제공자 (모델의 자기 보고 누락) */
const quiet = (answer: string) => new FakeProvider({ chat: () => ({ answer, used_refs: [] }) });

describe("검토 지적 1: 삭제는 모델의 자기 보고에 기대지 않는다", () => {
  it("반영 번호를 빠뜨린 답변도, 그 메모가 넘어갔다면 삭제 시 본문을 지우고 다시 쓰게 한다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "남은 예산은 4만 2천 원" });
    const t = await askInProject(s.bob, s.projectId, { question: "출력물 예산?" }, quiet("남은 예산이 4만 2천 원이라 최소로 출력하세요."));
    await deleteNote(s.alice, memo.noteId);
    const row = await getPool().query("select body, purged from advice_items where request_id = $1", [t.id]);
    expect(row.rows[0]).toMatchObject({ body: "", purged: true });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: true, answer: null });
  });

  it("회의록 삭제도 같은 기준", async () => {
    const s = await setup();
    const m = await createMeeting(s.alice, s.teamId, { title: "회의", date: "2026-11-06", text: "데모는 녹화" });
    const t = await askInProject(s.bob, s.projectId, { question: "데모?" }, quiet("데모는 녹화예요."));
    await manageMeeting(s.alice, m.noteId, { action: "delete" });
    const row = await getPool().query("select body from advice_items where request_id = $1", [t.id]);
    expect(row.rows[0].body).toBe("");
  });

  it("철회는 지금처럼 반영했다고 밝힌 답변만 다시 쓴다 (밝히지 않은 답변은 화면에 남고, 이어지는 대화에서는 빠진다)", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "리허설은 금요일" });
    const t = await askInProject(s.bob, s.projectId, { question: "리허설?" }, quiet("금요일이에요."));
    await withdrawNote(s.alice, memo.noteId);
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: false });
    const rec = recording(quiet("네"));
    await askInProject(s.bob, s.projectId, { question: "또?" }, rec.provider);
    expect(rec.calls.chat[0]!.history).toEqual([{ question: "리허설?", answer: null }]);
  });
});

describe("검토 지적 4: 긴 맥락에서도 현재 질문의 검색어를 지킨다", () => {
  it("프로젝트 설명이 길고 공유 지식이 30개를 넘어도, 지금 묻는 말과 관련된 메모를 찾는다", async () => {
    const longPurpose = Array.from({ length: 50 }, (_, i) => `목표어${i}`).join(" ");
    const s = await setup({ title: "본선 발표 준비", purpose: longPurpose });
    for (let i = 0; i < 35; i++) await shareSummary(s.alice, s.teamId, { text: `무관한 메모 ${i}번: 간식 목록 정리` });
    await shareSummary(s.alice, s.teamId, { text: "리허설 장소는 실험실 3층 세미나실" });
    const rec = recording(quiet("네"));
    await askInProject(s.bob, s.projectId, { question: "리허설 장소 어디야?" }, rec.provider);
    const texts = rec.calls.chat[0]!.knowledge.map((k) => k.text);
    expect(texts.length).toBeLessThanOrEqual(30);
    expect(texts).toContain("리허설 장소는 실험실 3층 세미나실");
  });

  it("이전 질문이 많아도 마찬가지", async () => {
    const s = await setup();
    for (let i = 0; i < 35; i++) await shareSummary(s.alice, s.teamId, { text: `무관한 메모 ${i}번: 간식 목록 정리` });
    await shareSummary(s.alice, s.teamId, { text: "예산은 거의 바닥남. 출력물 최소로" });
    for (let i = 0; i < 6; i++) {
      const words = Array.from({ length: 10 }, (_, j) => `이전주제${i}x${j}`).join(" ");
      await askInProject(s.bob, s.projectId, { question: words }, quiet("네"));
    }
    const rec = recording(quiet("네"));
    await askInProject(s.bob, s.projectId, { question: "출력물 예산 괜찮아?" }, rec.provider);
    expect(rec.calls.chat[0]!.knowledge.map((k) => k.text)).toContain("예산은 거의 바닥남. 출력물 최소로");
  });
});

describe("검토 지적 5: 공개 범위를 좁히면 예전 답변을 다시 쓴다", () => {
  it("팀 공유 → AI만 참고로 바꾸면, 그 메모를 반영한 답변은 다음에 열 때 'AI만 참고' 규칙으로 다시 쓰인다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "남은 예산은 4만 2천 원" });
    const used = new FakeProvider({ chat: (i) => ({ answer: "팀원이 공유한 메모에 따르면 남은 예산은 4만 2천 원이에요.", used_refs: i.knowledge.map((k) => k.ref) }) });
    const t = await askInProject(s.bob, s.projectId, { question: "예산?" }, used);
    expect((await listChat(s.bob, s.projectId))[0]!.sources).toHaveLength(1);
    await setVisibility(s.alice, memo.noteId, { visibility: "ai_only" });
    const after = (await listChat(s.bob, s.projectId))[0]!;
    expect(after).toMatchObject({ id: t.id, stale: true, answer: null, sources: [] });
  });
});
