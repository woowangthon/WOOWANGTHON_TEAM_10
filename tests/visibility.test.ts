import { describe, expect, it } from "vitest";
import { getAdvice, requestAdvice } from "../src/lib/advice.ts";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import { sourceLeaks } from "../src/lib/ai/validate-output.ts";
import { askInProject } from "../src/lib/chat.ts";
import { listMemos, setAiReference, setVisibility, shareSummary } from "../src/lib/memos.ts";
import { getNote, listNotes, withdrawNote } from "../src/lib/notes.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

const SECRET = "발표 리허설은 금요일 저녁 7시, 실험실 3층";

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const hidden = await shareSummary(alice, team.id, { text: SECRET, visibility: "ai_only" });
  const open = await shareSummary(alice, team.id, { text: "발표 슬라이드는 5장 이내" });
  const project = await createTask(bob, team.id, { title: "발표 리허설 준비", purpose: "리허설 일정 정리" });
  return { alice, bob, teamId: team.id, hidden, open, projectId: project.id as string };
}

describe("'AI만 참고' 공유", () => {
  it("팀원은 어느 경로로도 볼 수 없다 (작성자만 봄)", async () => {
    const s = await setup();
    const bobView = await listMemos(s.bob, s.teamId);
    expect(bobView.shared.map((x) => x.text)).toEqual(["발표 슬라이드는 5장 이내"]);
    expect(JSON.stringify(await listNotes(s.bob, s.teamId))).not.toContain("리허설");
    await expect(getNote(s.bob, s.hidden.noteId)).rejects.toMatchObject({ status: 404 });

    const aliceView = await listMemos(s.alice, s.teamId);
    expect(aliceView.shared.find((x) => x.id === s.hidden.noteId)).toMatchObject({ visibility: "ai_only", text: SECRET });
    expect((await getNote(s.alice, s.hidden.noteId)).versions[0]!.raw_text).toBe(SECRET);
  });

  it("AI 는 대화할 때 참고한다 (팀원에게 보이지 않는다는 표시와 함께, 작성자 정보 없이)", async () => {
    const s = await setup();
    const rec = recording(new FakeProvider({ chat: (i) => ({ answer: "리허설은 금요일 저녁에 하세요.", used_refs: i.knowledge.map((k) => k.ref) }) }));
    const t = await askInProject(s.bob, s.projectId, { question: "리허설 언제 해?" }, rec.provider);
    expect(t.answer).toBe("리허설은 금요일 저녁에 하세요.");
    const k = rec.calls.chat[0]!.knowledge;
    expect(k.find((x) => x.text === SECRET)).toMatchObject({ aiOnly: true });
    expect(k.find((x) => x.text === "발표 슬라이드는 5장 이내")).toMatchObject({ aiOnly: false });
    expect(JSON.stringify(rec.calls.chat[0])).not.toMatch(/alice|@example/);
  });

  it("근거 원문을 보여주는 이전 조언 흐름에는 쓰지 않는다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.projectId, { question: "리허설 일정" }, noAiProvider);
    expect(JSON.stringify(await getAdvice(s.bob, a.id))).not.toContain("금요일 저녁");
  });

  it("AI 참고를 끌 수 없고(철회·삭제로 멈춤), 범위는 작성자만 바꾼다", async () => {
    const s = await setup();
    await expect(setAiReference(s.alice, s.hidden.noteId, { allowExternalAi: false })).rejects.toMatchObject({ status: 409 });
    await expect(setVisibility(s.bob, s.hidden.noteId, { visibility: "team" })).rejects.toMatchObject({ status: 404 });

    await setVisibility(s.alice, s.hidden.noteId, { visibility: "team" });
    expect((await listMemos(s.bob, s.teamId)).shared.map((x) => x.text)).toContain(SECRET);
    // 팀 공유 → AI만 참고: AI 참고를 꺼 둔 것이었어도 켜진다
    await setAiReference(s.alice, s.open.noteId, { allowExternalAi: false });
    await setVisibility(s.alice, s.open.noteId, { visibility: "ai_only" });
    const bobView = await listMemos(s.bob, s.teamId);
    expect(bobView.shared.map((x) => x.text)).toEqual([SECRET]);
    expect((await listMemos(s.alice, s.teamId)).shared.find((x) => x.id === s.open.noteId)).toMatchObject({ visibility: "ai_only", allowExternalAi: true });

    // 철회하면 AI 도 더 이상 참고하지 않는다
    await withdrawNote(s.alice, s.open.noteId);
    const rec = recording(new FakeProvider({ chat: () => ({ answer: "네", used_refs: [] }) }));
    await askInProject(s.bob, s.projectId, { question: "슬라이드?" }, rec.provider);
    expect(rec.calls.chat[0]!.knowledge.map((x) => x.text)).not.toContain("발표 슬라이드는 5장 이내");
  });

  it("공유 범위 값 검사", async () => {
    const s = await setup();
    await expect(shareSummary(s.alice, s.teamId, { text: "x", visibility: "everyone" })).rejects.toMatchObject({ status: 400 });
  });

  it("비공개 정보가 있다는 사실을 드러내는 표현을 잡는다", () => {
    expect(sourceLeaks("비공개 메모에 따르면 금요일이에요.")).not.toEqual([]);
    expect(sourceLeaks("팀원에게 보이지 않는 정보라서 자세히는 말할 수 없어요.")).not.toEqual([]);
    expect(sourceLeaks("팀원들이 공개하지 않은 내용을 원문 그대로 보여줄 수는 없어.")).not.toEqual([]);
    expect(sourceLeaks("나한테만 알려 준 정보는 없어요.")).not.toEqual([]);
    expect(sourceLeaks("팀원들이 개인적으로 알려준 내용을 원문 그대로 공개할 수는 없어요.")).not.toEqual([]);
    expect(sourceLeaks("그 내용은 공유해 드릴 수 없어요.")).not.toEqual([]);
    expect(sourceLeaks("리허설은 금요일 저녁이 좋겠어요.")).toEqual([]);
  });
});
