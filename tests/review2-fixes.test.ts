// 11/8 재검토(수정 후 원점 재검토)에서 지적된 결함을 재현하고, 고친 뒤 동작을 고정한다.
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { chatUser } from "../src/lib/ai/prompts.ts";
import { askInProject, listChat, todayKst } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { createMeeting } from "../src/lib/meetings.ts";
import { setVisibility, shareSummary } from "../src/lib/memos.ts";
import { deleteNote } from "../src/lib/notes.ts";
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

const quiet = (answer: string) => new FakeProvider({ chat: () => ({ answer, used_refs: [] }) });
/** 검색어 앞 40개를 모두 차지해 다른 지식이 후보에서 빠지게 하는 질문 */
const unrelatedQuestion = (tag: string) => Array.from({ length: 45 }, (_, i) => `무관${tag}낱말${i}`).join(" ");

async function fillUnrelated(s: Awaited<ReturnType<typeof setup>>, n = 35) {
  for (let i = 0; i < n; i++) await shareSummary(s.alice, s.teamId, { text: `무관한 메모 ${i}번: 간식 목록 정리` });
}

describe("재검토 지적 1: 이전 답변을 거쳐 퍼진 정보도 원래 메모를 지우면 함께 지운다", () => {
  it("두 번째 답변이 검색으로는 메모를 받지 않고 이전 답변만 보고 금액을 반복했어도, 메모 삭제 시 함께 지워진다", async () => {
    const s = await setup();
    await fillUnrelated(s);
    const memo = await shareSummary(s.alice, s.teamId, { text: "남은 예산은 42000원" });
    const first = await askInProject(s.bob, s.projectId, { question: "남은 예산 얼마야?" }, quiet("예산은 42000원입니다."));

    const rec = recording(quiet("앞서 말한 대로 예산은 42000원입니다."));
    const second = await askInProject(s.bob, s.projectId, { question: unrelatedQuestion("a") }, rec.provider);
    // 재현 조건: 두 번째 요청은 검색으로 그 메모를 받지 않았고, 이전 답변만 받았다
    expect(rec.calls.chat[0]!.knowledge.map((k) => k.text)).not.toContain("남은 예산은 42000원");
    expect(rec.calls.chat[0]!.history).toContainEqual({ question: "남은 예산 얼마야?", answer: "예산은 42000원입니다." });

    await deleteNote(s.alice, memo.noteId);
    const rows = await getPool().query("select request_id, body, purged from advice_items where request_id = any($1)", [[first.id, second.id]]);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) expect(r).toMatchObject({ body: "", purged: true });

    // 이어지는 대화에도 두 답변 모두 넘어가지 않는다
    const next = recording(quiet("네"));
    await askInProject(s.bob, s.projectId, { question: "또?" }, next.provider);
    expect(next.calls.chat[0]!.history.map((h) => h.answer).join(" ")).not.toContain("42000");
  });

  it("이전 답변이 쓸 수 없게 된 지식에 기댔다면 물려받지 않는다 (질문만 넘김)", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "리허설은 금요일" });
    await askInProject(s.bob, s.projectId, { question: "리허설?" }, quiet("금요일이에요."));
    await deleteNote(s.alice, memo.noteId);
    const rec = recording(quiet("네"));
    const t = await askInProject(s.bob, s.projectId, { question: "다른 질문" }, rec.provider);
    const ids = await getPool().query("select input_version_ids from advice_requests where id = $1", [t.id]);
    expect(ids.rows[0].input_version_ids).toEqual([]);
  });
});

describe("재검토 지적 2: 답을 만드는 사이에 범위를 좁히면 이전 규칙으로 저장하지 않는다", () => {
  it("모델이 공개 메모를 받은 뒤 응답 전에 'AI만 참고'로 바뀌면, 그 답변은 저장되지 않고 다시 쓰기 대상이 된다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "남은 예산은 42000원" });
    const racing = new FakeProvider({
      chat: async (i) => {
        await setVisibility(s.alice, memo.noteId, { visibility: "ai_only" });
        return { answer: "팀원이 공유한 메모에 따르면 남은 예산은 42000원입니다.", used_refs: i.knowledge.map((k) => k.ref) };
      },
    });
    const t = await askInProject(s.bob, s.projectId, { question: "예산?" }, racing);
    expect(t).toMatchObject({ stale: true, answer: null });
    const row = await getPool().query("select status from advice_requests where id = $1", [t.id]);
    expect(row.rows[0].status).toBe("invalidated");
    const items = await getPool().query("select count(*)::int as n from advice_items where request_id = $1", [t.id]);
    expect(items.rows[0].n).toBe(0);
  });

  it("다시 쓸 때는 바뀐 범위('AI만 참고')로 넘긴다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "남은 예산은 42000원" });
    await setVisibility(s.alice, memo.noteId, { visibility: "ai_only" });
    const rec = recording(quiet("예산이 넉넉하지 않아요."));
    await askInProject(s.bob, s.projectId, { question: "예산?" }, rec.provider);
    expect(rec.calls.chat[0]!.knowledge[0]).toMatchObject({ aiOnly: true });
  });
});

describe("재검토 지적 3: 범위를 좁히면 반영 보고가 없던 예전 답변도 다시 쓰고, 이어지는 대화에 넘기지 않는다", () => {
  it("used_refs 가 빈 답변도 범위 축소 후 다시 쓰기 대상이 되고, 다음 질문의 history 에 들어가지 않는다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "리허설 예산은 42000원" });
    const t = await askInProject(s.bob, s.projectId, { question: "리허설 예산?" }, quiet("리허설 예산은 42000원입니다."));
    await setVisibility(s.alice, memo.noteId, { visibility: "ai_only" });
    expect((await listChat(s.bob, s.projectId))[0]).toMatchObject({ id: t.id, stale: true, answer: null });
    const rec = recording(quiet("네"));
    await askInProject(s.bob, s.projectId, { question: "또?" }, rec.provider);
    expect(JSON.stringify(rec.calls.chat[0]!.history)).not.toContain("42000");
  });
});

describe("재검토 지적 4: 긴 회의록의 마지막 결정까지 모델에 넘긴다", () => {
  it("7,500자 회의록 끝의 '최종 결정'이 모델 입력에 들어간다", async () => {
    const s = await setup();
    const background = "배경 설명과 여러 의견을 길게 나눴다. ".repeat(380).slice(0, 7480);
    await createMeeting(s.alice, s.teamId, { title: "발표자 회의", date: "2026-11-07", text: `${background}\n최종 결정: 발표자는 나연` });
    const rec = recording(quiet("발표자는 나연이에요."));
    await askInProject(s.bob, s.projectId, { question: "발표자 누구야?" }, rec.provider);
    const meeting = rec.calls.chat[0]!.knowledge.find((k) => k.meeting);
    expect(meeting!.text.length).toBeGreaterThan(7000);
    expect(meeting!.text).toContain("최종 결정: 발표자는 나연");
  });
});

describe("재검토 지적 5: 일정 판단의 기준 날짜를 넘긴다", () => {
  it("오늘 날짜(한국 시간·요일)를 계산한다", () => {
    expect(todayKst(new Date("2026-11-08T15:30:00Z"))).toBe("2026-11-09 (월)");
    expect(todayKst(new Date("2026-11-08T14:59:00Z"))).toBe("2026-11-08 (일)");
  });

  it("대화 입력에 오늘 날짜와 메모를 쓴 날을 넣는다", async () => {
    const s = await setup();
    await shareSummary(s.alice, s.teamId, { text: "다음 주 금요일에 리허설" });
    const rec = recording(quiet("네"));
    await askInProject(s.bob, s.projectId, { question: "리허설 언제?" }, rec.provider);
    const input = rec.calls.chat[0]!;
    expect(input.today).toBe(todayKst());
    expect(input.knowledge[0]!.writtenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const prompt = chatUser(input);
    expect(prompt).toContain(`<today>${todayKst()}</today>`);
    expect(prompt).toContain(`written="${input.knowledge[0]!.writtenOn}"`);
  });
});
