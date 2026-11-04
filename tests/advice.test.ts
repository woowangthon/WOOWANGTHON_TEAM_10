import { describe, expect, it } from "vitest";
import { getAdvice, listAdviceRequests, reactToItem, requestAdvice } from "../src/lib/advice.ts";
import { FAKE_LABEL, FakeProvider } from "../src/lib/ai/fake.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import type { AdviseInput, JudgeInput } from "../src/lib/ai/types.ts";
import { getPool } from "../src/lib/db.ts";
import { confirmVersion, createNote, deleteNote, editNote, shareNote, withdrawNote } from "../src/lib/notes.ts";
import { createTask, updateTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam, leaveTeam } from "../src/lib/teams.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

const EXP = "두 실험은 측정 조건이 달라 보임. 숫자만 비교하면 오해할 수도";
const ROOM = "회의실 예약 목요일로 바꿈";

async function share(userId: string, teamId: string, raw: string, allowExternalAi = true) {
  const n = await createNote(userId, teamId, { rawText: raw, allowExternalAi });
  await confirmVersion(userId, n.noteId, n.versionId, { choice: "raw_only", expectedHash: n.contentHash });
  await shareNote(userId, n.noteId, n.versionId);
  return n;
}

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const exp = await share(alice, team.id, EXP);
  const room = await share(alice, team.id, ROOM);
  const task = await createTask(bob, team.id, {
    title: "비전공자 대상 3분 발표 구성",
    purpose: "실험 결과를 쉽게 설명",
    audience: "비전공자",
    constraints: "슬라이드 3장, 숫자 비교 포함",
  });
  return { alice, bob, teamId: team.id, inviteCode: team.inviteCode, exp, room, taskId: task.id as string };
}

/** 판정은 N1(실험 메모)만 관련으로, 조언은 주어진 항목을 그대로 돌려주는 제공자 */
function scripted(items: unknown, judge?: (i: JudgeInput) => unknown) {
  return new FakeProvider({
    judge:
      judge ??
      ((i) => ({ judgments: i.candidates.map((c) => ({ ref: c.ref, relevant: c.text.includes("실험"), stance: "caution" })) })),
    advise: () => ({ items }),
  });
}

describe("AI 미연결(키워드) 모드", () => {
  it("키워드가 겹치는 공유 메모만 '팀 메모에 있는 내용'으로 보여주고, AI 해석은 만들지 않는다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.taskId, {}, noAiProvider);
    expect(a.status).toBe("ok");
    expect(a.provider).toBe("none");
    expect(a.items).toHaveLength(1);
    expect(a.items[0]!.section).toBe("direct");
    const ev = a.items[0]!.evidence[0]!;
    expect(ev.available && ev.text).toBe(EXP);
    expect(ev.available && ev.authorName).toBe("alice");
  });

  it("팀 기억이 비어 있으면 '관련 자료 없음'으로 끝난다", async () => {
    const carol = await makeUser("carol");
    const team = await createTeam(carol, "빈팀");
    const task = await createTask(carol, team.id, { title: "아무 작업" });
    const a = await requestAdvice(carol, task.id, {}, noAiProvider);
    expect(a.status).toBe("ok");
    expect(a.items).toHaveLength(0);
    expect(a.emptyReason).toBe("no_related_notes");
  });

  it("작업 맥락이 부족하면 안내를 덧붙인다", async () => {
    const s = await setup();
    const t = await createTask(s.bob, s.teamId, { title: "숫자 비교 슬라이드" });
    const a = await requestAdvice(s.bob, t.id, {}, noAiProvider);
    expect(a.hints.length).toBe(2);
  });
});

describe("AI 연결 지점 (가짜 제공자로 검증)", () => {
  it("개발용 가짜 응답은 표시가 붙고, 구획별로 나뉘어 저장된다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.taskId, {}, new FakeProvider());
    expect(a.status).toBe("ok");
    expect(new Set(a.items.map((i) => i.section))).toEqual(new Set(["direct", "link_reason", "objection", "extra"]));
    for (const i of a.items) expect(i.body).toContain(FAKE_LABEL);
    // 관련 없는 회의실 메모는 근거로 쓰이지 않는다
    const cited = a.items.flatMap((i) => i.evidence.map((e) => e.versionId));
    expect(cited).toContain(s.exp.versionId);
    expect(cited).not.toContain(s.room.versionId);
  });

  it("모델에는 작성자 이름·이메일·실제 ID 를 보내지 않는다", async () => {
    const s = await setup();
    const { provider, calls } = recording(new FakeProvider());
    await requestAdvice(s.bob, s.taskId, {}, provider);
    const sent = JSON.stringify(calls);
    expect(sent).toContain("실험");
    expect(sent).not.toMatch(/alice|bob|example\.com/);
    expect(sent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("다른 팀 메모와 AI 처리를 허용하지 않은 메모는 모델에 가지 않는다", async () => {
    const s = await setup();
    await share(s.alice, s.teamId, "실험 숫자 비교는 민감함", false);
    const mallory = await makeUser("mallory");
    const other = await createTeam(mallory, "M팀");
    await share(mallory, other.id, "실험 숫자 비교 슬라이드 비밀");
    const { provider, calls } = recording(new FakeProvider());
    await requestAdvice(s.bob, s.taskId, {}, provider);
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain("민감함");
    expect(sent).not.toContain("비밀");
    // 같은 메모라도 AI 미연결 모드에서는 팀원에게 보여줄 수 있다
    const kw = await requestAdvice(s.bob, s.taskId, {}, noAiProvider);
    expect(kw.items.some((i) => i.evidence.some((e) => e.available && e.text.includes("민감함")))).toBe(true);
  });

  it("작은 팀이면 키워드가 안 겹쳐도 판정에는 넘기지만, 조언 생성에는 관련 판정된 메모만 넘긴다", async () => {
    const s = await setup();
    const { provider, calls } = recording(new FakeProvider());
    await requestAdvice(s.bob, s.taskId, {}, provider);
    const judged = calls.judge[0]!.candidates.map((c) => c.text);
    expect(judged).toEqual(expect.arrayContaining([EXP, ROOM]));
    const advised = (calls.advise[0] as AdviseInput).notes.map((n) => n.text);
    expect(advised).toEqual([EXP]);
  });

  it("지어낸 근거, 관련 없다고 판정된 메모 인용, 원문에 없는 인용은 버린다", async () => {
    const s = await setup();
    const p = scripted([
      { section: "direct", body: "정상", evidence: [{ ref: "N1", quote: "측정 조건이 달라" }] },
      { section: "direct", body: "지어낸 근거", evidence: [{ ref: "N9", quote: "측정" }] },
      { section: "direct", body: "판정 밖 메모", evidence: [{ ref: "N2", quote: "회의실" }] },
      { section: "ai_extension", body: "가짜 인용", evidence: [{ ref: "N1", quote: "A가 우수함" }] },
    ]);
    const a = await requestAdvice(s.bob, s.taskId, {}, p);
    expect(a.items.map((i) => i.body)).toEqual(["정상"]);
    expect(a.droppedCount).toBe(3);
  });

  it("모델이 쓸 만한 항목을 하나도 못 내면 그렇게 표시한다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.taskId, {}, scripted([{ section: "direct", body: "x", evidence: [{ ref: "N9" }] }]));
    expect(a.status).toBe("ok");
    expect(a.items).toHaveLength(0);
    expect(a.emptyReason).toBe("no_valid_items");
  });

  it("관련 메모가 없다고 판정되면 조언 생성 단계를 부르지 않는다", async () => {
    const s = await setup();
    const { provider, calls } = recording(scripted([], (i) => ({ judgments: i.candidates.map((c) => ({ ref: c.ref, relevant: false })) })));
    const a = await requestAdvice(s.bob, s.taskId, {}, provider);
    expect(a.emptyReason).toBe("no_related_notes");
    expect(calls.advise).toHaveLength(0);
  });

  it("모델 출력 형식 오류·호출 실패·시간 초과는 '실패'로 남기고 결과를 꾸며내지 않는다", async () => {
    const s = await setup();
    const bad = await requestAdvice(s.bob, s.taskId, {}, new FakeProvider({ advise: () => "자유 형식 답변" }));
    expect([bad.status, bad.error, bad.items.length]).toEqual(["failed", "invalid_ai_output", 0]);

    const boom = await requestAdvice(s.bob, s.taskId, {}, new FakeProvider({ judge: () => { throw new Error("500"); } }));
    expect([boom.status, boom.error]).toEqual(["failed", "ai_error"]);

    process.env.AI_TIMEOUT_MS = "1000";
    try {
      const slow = await requestAdvice(s.bob, s.taskId, {}, new FakeProvider({ advise: () => new Promise(() => {}) }));
      expect([slow.status, slow.error]).toEqual(["failed", "ai_timeout"]);
    } finally {
      delete process.env.AI_TIMEOUT_MS;
    }
  });
});

describe("생성 중·생성 후 변경 반영", () => {
  const valid = [{ section: "direct", body: "조건 확인 슬라이드 추가", evidence: [{ ref: "N1", quote: "측정 조건" }], action: "조건 확인" }];

  it("생성 중에 근거 메모가 철회되면 결과를 저장하지 않는다", async () => {
    const s = await setup();
    const p = new FakeProvider({
      advise: async () => {
        await withdrawNote(s.alice, s.exp.noteId);
        return { items: valid };
      },
    });
    const a = await requestAdvice(s.bob, s.taskId, {}, p);
    expect(a.status).toBe("invalidated");
    expect(a.items).toHaveLength(0);
  });

  it("생성 중에 작업이 수정되면 무효화한다", async () => {
    const s = await setup();
    const p = new FakeProvider({
      advise: async () => {
        await updateTask(s.bob, s.taskId, { title: "다른 작업으로 바뀜" });
        return { items: valid };
      },
    });
    const a = await requestAdvice(s.bob, s.taskId, {}, p);
    expect([a.status, a.error]).toEqual(["invalidated", "task_changed"]);
  });

  it("생성 중에 요청자가 팀을 떠나면 저장하지 않는다", async () => {
    const s = await setup();
    const p = new FakeProvider({
      advise: async () => {
        await leaveTeam(s.bob, s.teamId);
        return { items: valid };
      },
    });
    await expect(requestAdvice(s.bob, s.taskId, {}, p)).rejects.toMatchObject({ status: 404 });
    const r = await getPool().query("select status, error from advice_requests");
    expect(r.rows[0]).toMatchObject({ status: "invalidated", error: "requester_left" });
  });

  it("생성 후 근거 메모를 철회·수정하면 다시 열 때 본문을 숨긴다", async () => {
    for (const change of ["withdraw", "edit"] as const) {
      const s = await setup();
      const a = await requestAdvice(s.bob, s.taskId, {}, scripted(valid));
      expect(a.items[0]!.body).toBe("조건 확인 슬라이드 추가");
      if (change === "withdraw") await withdrawNote(s.alice, s.exp.noteId);
      else await editNote(s.alice, s.exp.noteId, "다시 보니 조건은 같았음");
      const again = await getAdvice(s.bob, a.id);
      expect(again.status).toBe("invalidated");
      expect(again.items[0]!.body).toBeNull();
      expect(JSON.stringify(again)).not.toContain("측정 조건");
      await getPool().query("truncate audit_log, reactions, advice_items, advice_requests, note_versions, notes, tasks, memberships, teams, users cascade");
    }
  });

  it("근거 메모를 삭제하면 저장된 조언 본문·인용도 DB 에서 지운다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.taskId, {}, scripted(valid));
    await deleteNote(s.alice, s.exp.noteId);
    const rows = await getPool().query("select body, quotes::text as q, purged from advice_items where request_id = $1", [a.id]);
    expect(rows.rows).toEqual([{ body: "", q: "[]", purged: true }]);
  });
});

describe("접근 범위와 반응", () => {
  it("조언은 요청한 사람만 볼 수 있다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.taskId, {}, noAiProvider);
    const mallory = await makeUser("mallory");
    await createTeam(mallory, "M팀");
    await expect(getAdvice(s.alice, a.id)).rejects.toMatchObject({ status: 404 });
    await expect(getAdvice(mallory, a.id)).rejects.toMatchObject({ status: 404 });
    await expect(requestAdvice(mallory, s.taskId, {}, noAiProvider)).rejects.toMatchObject({ status: 404 });
    expect(await listAdviceRequests(s.alice, s.taskId)).toHaveLength(0);
    expect(await listAdviceRequests(s.bob, s.taskId)).toHaveLength(1);
  });

  it("같은 요청 번호로 두 번 눌러도 요청·모델 호출은 한 번", async () => {
    const s = await setup();
    const { provider, calls } = recording(new FakeProvider());
    const id = "7b0e7a1c-1d2e-4f00-8a00-000000000001";
    const a = await requestAdvice(s.bob, s.taskId, { clientRequestId: id }, provider);
    const b = await requestAdvice(s.bob, s.taskId, { clientRequestId: id }, provider);
    expect(b.id).toBe(a.id);
    expect(calls.judge).toHaveLength(1);
  });

  it("제외한 제안은 다음 요청에서 '이전에 제외함'으로 표시되고, 모델에도 알려준다", async () => {
    const s = await setup();
    const first = await requestAdvice(s.bob, s.taskId, {}, new FakeProvider());
    const target = first.items.find((i) => i.section === "objection")!;
    await reactToItem(s.bob, target.id, { reaction: "exclude", reason: "이미 반영함" });

    const { provider, calls } = recording(new FakeProvider());
    const second = await requestAdvice(s.bob, s.taskId, {}, provider);
    const same = second.items.find((i) => i.section === "objection")!;
    expect(same.declinedEarlier).toBe(true);
    expect(same.myReaction).toEqual({ reaction: "exclude", reason: "이미 반영함" });
    expect(calls.advise[0]!.declined).toEqual([{ reaction: "exclude", action: "조건 확인", refs: ["N1"] }]);
    // 다른 제안은 영향을 받지 않는다
    expect(second.items.filter((i) => i.declinedEarlier)).toHaveLength(1);
  });

  it("남의 조언이나 무효가 된 조언에는 반응할 수 없다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.bob, s.taskId, {}, noAiProvider);
    const itemId = a.items[0]!.id;
    await expect(reactToItem(s.alice, itemId, { reaction: "apply" })).rejects.toMatchObject({ status: 404 });
    await expect(reactToItem(s.bob, itemId, { reaction: "agree" })).rejects.toMatchObject({ status: 400 });
    await withdrawNote(s.alice, s.exp.noteId);
    await expect(reactToItem(s.bob, itemId, { reaction: "apply" })).rejects.toMatchObject({ status: 409 });
  });
});
