import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import { confirmVersion, createNote, editNote, getNote, shareNote } from "../src/lib/notes.ts";
import { restateNote } from "../src/lib/restate.ts";
import { searchCandidates } from "../src/lib/search.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

async function setup(raw = "비교가 이상함. 조건이 다른 듯", allowExternalAi = true) {
  const alice = await makeUser("alice");
  const team = await createTeam(alice, "A팀");
  const n = await createNote(alice, team.id, { rawText: raw, allowExternalAi });
  return { alice, teamId: team.id, inviteCode: team.inviteCode, ...n };
}

const ok = (summary: string, extra: object = {}) => ({
  summary,
  kind: "guess",
  conditions: [],
  uncertainties: [],
  clarifying_question: null,
  ...extra,
});

describe("메모 정리(재진술)", () => {
  it("AI 미연결이면 503, 원문은 그대로", async () => {
    const s = await setup();
    await expect(restateNote(s.alice, s.noteId, s.versionId, noAiProvider)).rejects.toMatchObject({ status: 503, code: "ai_unavailable" });
    const note = await getNote(s.alice, s.noteId);
    expect(note.versions[0]!.raw_text).toBe("비교가 이상함. 조건이 다른 듯");
    expect(note.versions[0]!.restated).toBeNull();
  });

  it("정리 결과는 붙지만 확인 전에는 공유할 수 없고, 확인하면 공유·검색된다", async () => {
    const s = await setup();
    const res = await restateNote(s.alice, s.noteId, s.versionId, new FakeProvider({ restate: () => ok("두 결과의 비교 조건이 다를 수 있음") }));
    expect(res.restated.summary).toBe("두 결과의 비교 조건이 다를 수 있음");
    expect(res.contentHash).not.toBe(s.contentHash);
    await expect(shareNote(s.alice, s.noteId, s.versionId)).rejects.toMatchObject({ status: 409 });
    await confirmVersion(s.alice, s.noteId, s.versionId, { choice: "confirmed", expectedHash: res.contentHash });
    await shareNote(s.alice, s.noteId, s.versionId);
    // 정리문에만 있는 단어로도 검색된다
    expect(await searchCandidates(s.alice, s.teamId, "결과", { requireExternalAi: true })).toHaveLength(1);
  });

  it("AI 정리를 허용하지 않은 메모는 모델에 보내지 않는다", async () => {
    const s = await setup("민감한 생각", false);
    const { provider, calls } = recording(new FakeProvider());
    await expect(restateNote(s.alice, s.noteId, s.versionId, provider)).rejects.toMatchObject({ status: 409 });
    expect(calls.restate).toHaveLength(0);
  });

  it("다른 사람은 남의 메모를 정리시킬 수 없고, 모델도 호출되지 않는다", async () => {
    const s = await setup();
    const bob = await makeUser("bob");
    await joinTeam(bob, s.inviteCode);
    const { provider, calls } = recording(new FakeProvider());
    await expect(restateNote(bob, s.noteId, s.versionId, provider)).rejects.toMatchObject({ status: 404 });
    expect(calls.restate).toHaveLength(0);
  });

  it("모델이 '팀 결정'으로 승격하거나 형식을 틀리면 버리고 원문을 지킨다", async () => {
    const s = await setup();
    for (const bad of [ok("A안으로 결정", { kind: "decision" }), { summary: 3 }, "문자열", null]) {
      await expect(restateNote(s.alice, s.noteId, s.versionId, new FakeProvider({ restate: () => bad }))).rejects.toMatchObject({
        status: 502,
        code: "invalid_ai_output",
      });
    }
    expect((await getNote(s.alice, s.noteId)).versions[0]!.restated).toBeNull();
  });

  it("모델 호출 실패·시간 초과도 원문을 지킨다", async () => {
    const s = await setup();
    const boom = new FakeProvider({ restate: () => { throw new Error("network"); } });
    await expect(restateNote(s.alice, s.noteId, s.versionId, boom)).rejects.toMatchObject({ status: 502, code: "ai_error" });
    process.env.AI_TIMEOUT_MS = "1000";
    try {
      const hang = new FakeProvider({ restate: () => new Promise(() => {}) });
      await expect(restateNote(s.alice, s.noteId, s.versionId, hang)).rejects.toMatchObject({ status: 504, code: "ai_timeout" });
    } finally {
      delete process.env.AI_TIMEOUT_MS;
    }
    expect((await getNote(s.alice, s.noteId)).versions[0]!.restated).toBeNull();
  });

  it("정리하는 사이 작성자가 메모를 고치면, 옛 원문의 정리 결과는 붙지 않는다", async () => {
    const s = await setup();
    const racing = new FakeProvider({
      restate: async () => {
        await editNote(s.alice, s.noteId, "아니다, 조건은 같았음");
        return ok("비교 조건이 다를 수 있음");
      },
    });
    await expect(restateNote(s.alice, s.noteId, s.versionId, racing)).rejects.toMatchObject({ status: 409 });
    const note = await getNote(s.alice, s.noteId);
    expect(note.versions.map((v) => v.restated)).toEqual([null, null]);
  });

  it("원문에 없는 숫자를 넣으면 경고하고, 제어 문자는 지운다", async () => {
    const s = await setup();
    const res = await restateNote(s.alice, s.noteId, s.versionId, new FakeProvider({ restate: () => ok("정확도 95%‮ 차이") }));
    expect(res.warnings.join(" ")).toContain("95");
    expect(res.restated.summary).toBe("정확도 95% 차이");
  });
});
