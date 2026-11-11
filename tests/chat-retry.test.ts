// 실패한 질문 다시 답하기, 그리고 모델 호출의 시간 초과가 실제 요청을 멈추는지.
//  - 같은 요청 식별자는 "같은 질문을 두 번 저장하지 않는다"는 뜻이지 "실패를 영원히 돌려준다"는 뜻이 아니다.
//  - 호출자가 시간 초과로 포기했다면 뒤에서 요청과 재시도가 계속되면 안 된다.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { OpenAiProvider } from "../src/lib/ai/openai.ts";
import { AiTimeout, withTimeout } from "../src/lib/ai/timeout.ts";
import type { ChatInput } from "../src/lib/ai/types.ts";
import { askInProject, listChat, retryChatTurn } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, useCleanDb } from "./helpers.ts";

useCleanDb();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 켜고 끌 수 있는 모델: failing 이 true 면 오류를 낸다. 호출 횟수와 받은 입력을 기록한다. */
function flaky() {
  const state = { failing: true, calls: 0, inputs: [] as ChatInput[], delayMs: 0 };
  const provider = new FakeProvider({
    chat: async (input) => {
      state.calls += 1;
      state.inputs.push(input);
      if (state.delayMs) await sleep(state.delayMs);
      if (state.failing) throw new Error("모델 서버 오류");
      return { answer: `"${input.question}"에 대한 답`, used_refs: [] };
    },
  });
  return { state, provider };
}

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const project = await createTask(alice, team.id, { title: "발표 준비" });
  return { alice, bob, teamId: team.id as string, projectId: project.id as string };
}

describe("실패한 질문 다시 답하기", () => {
  it("실패한 질문을 같은 요청 식별자로 다시 보내면 다시 답하고, 질문은 하나만 남는다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    const clientRequestId = randomUUID();
    const first = await askInProject(s.alice, s.projectId, { question: "첫 장은 어떻게 시작할까?", clientRequestId }, provider);
    expect(first).toMatchObject({ status: "failed", error: "ai_error", answer: null });
    expect(state.calls).toBe(1);

    state.failing = false; // 모델이 정상으로 돌아옴
    const second = await askInProject(s.alice, s.projectId, { question: "첫 장은 어떻게 시작할까?", clientRequestId }, provider);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ status: "ok", error: null });
    expect(second.answer).toContain("첫 장은 어떻게 시작할까?");
    expect(state.calls).toBe(2);
    expect(await listChat(s.alice, s.projectId)).toHaveLength(1);
  });

  it("이미 답한 질문을 같은 식별자로 다시 보내면 모델을 다시 부르지 않는다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    state.failing = false;
    const clientRequestId = randomUUID();
    const first = await askInProject(s.alice, s.projectId, { question: "마감이 언제야?", clientRequestId }, provider);
    const again = await askInProject(s.alice, s.projectId, { question: "마감이 언제야?", clientRequestId }, provider);
    expect(again).toMatchObject({ id: first.id, status: "ok", answer: first.answer });
    expect(state.calls).toBe(1);
  });

  it("아직 처리 중인 질문을 같은 식별자로 다시 보내면 모델을 한 번 더 부르지 않는다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    state.failing = false;
    state.delayMs = 300;
    const clientRequestId = randomUUID();
    const running = askInProject(s.alice, s.projectId, { question: "리허설은 언제 해?", clientRequestId }, provider);
    await sleep(100); // 첫 요청이 모델을 기다리는 중
    const duplicate = await askInProject(s.alice, s.projectId, { question: "리허설은 언제 해?", clientRequestId }, provider);
    expect(duplicate).toMatchObject({ status: "pending", answer: null });
    expect((await running).status).toBe("ok");
    expect(state.calls).toBe(1);
  });

  it("「다시 시도」는 실패한 내 질문만 다시 답한다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    const failed = await askInProject(s.alice, s.projectId, { question: "그래프는 어떻게 그릴까?" }, provider);
    expect(failed.status).toBe("failed");

    // 다른 팀원은 내 질문을 다시 시도할 수 없다 (대화는 묻는 사람에게만 보인다)
    await expect(retryChatTurn(s.bob, s.projectId, failed.id, provider)).rejects.toMatchObject({ status: 404 });
    expect(state.calls).toBe(1);

    state.failing = false;
    const retried = await retryChatTurn(s.alice, s.projectId, failed.id, provider);
    expect(retried).toMatchObject({ id: failed.id, status: "ok" });
    expect(state.calls).toBe(2);

    // 이미 답한 질문은 다시 시도해도 그대로다
    const unchanged = await retryChatTurn(s.alice, s.projectId, failed.id, provider);
    expect(unchanged.answer).toBe(retried.answer);
    expect(state.calls).toBe(2);
    expect(await listChat(s.alice, s.projectId)).toHaveLength(1);
  });

  it("동시에 두 번 다시 시도해도 모델은 한 번만 부른다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    const failed = await askInProject(s.alice, s.projectId, { question: "발표 시간은 몇 분이야?" }, provider);
    state.failing = false;
    state.delayMs = 150;
    const [a, b] = await Promise.all([
      retryChatTurn(s.alice, s.projectId, failed.id, provider),
      retryChatTurn(s.alice, s.projectId, failed.id, provider),
    ]);
    expect(state.calls).toBe(2); // 처음 실패 1회 + 다시 시도 1회
    expect([a.status, b.status].sort()).toEqual(["ok", "pending"]); // 늦은 쪽은 진행 중인 상태를 본다
    expect((await listChat(s.alice, s.projectId))[0]).toMatchObject({ status: "ok" });
  });

  it("다시 실패하면 실패로 남고, 또 다시 시도할 수 있다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    const failed = await askInProject(s.alice, s.projectId, { question: "예산은 얼마 남았어?" }, provider);
    const again = await retryChatTurn(s.alice, s.projectId, failed.id, provider);
    expect(again).toMatchObject({ status: "failed", error: "ai_error", answer: null });
    state.failing = false;
    expect((await retryChatTurn(s.alice, s.projectId, failed.id, provider)).status).toBe("ok");
    expect(state.calls).toBe(3);
  });

  it("뒤에 다른 질문이 이어진 실패한 질문은 그 시점까지의 대화만 넘겨 다시 답한다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    const failed = await askInProject(s.alice, s.projectId, { question: "첫 번째 질문" }, provider);
    state.failing = false;
    await askInProject(s.alice, s.projectId, { question: "두 번째 질문" }, provider);
    await retryChatTurn(s.alice, s.projectId, failed.id, provider);
    const last = state.inputs.at(-1)!;
    expect(last.question).toBe("첫 번째 질문");
    expect(last.history.map((h) => h.question)).not.toContain("두 번째 질문");
    const turns = await listChat(s.alice, s.projectId);
    expect(turns.map((t) => [t.question, t.status])).toEqual([["첫 번째 질문", "ok"], ["두 번째 질문", "ok"]]);
  });

  it("처리 중에 서버가 멈춰 5분 넘게 남은 질문도 다시 시도할 수 있다", async () => {
    const s = await setup();
    const { state, provider } = flaky();
    state.failing = false;
    const t = await askInProject(s.alice, s.projectId, { question: "멈춘 질문" }, provider);
    // 답을 만들던 서버가 중간에 멈춘 상태를 흉내 낸다
    await getPool().query("delete from advice_items where request_id = $1", [t.id]);
    await getPool().query("update advice_requests set status = 'pending', started_at = now() - interval '6 minutes', finished_at = null where id = $1", [t.id]);
    const retried = await retryChatTurn(s.alice, s.projectId, t.id, provider);
    expect(retried).toMatchObject({ id: t.id, status: "ok" });
    expect(state.calls).toBe(2);
  });
});

describe("모델 호출의 시간 초과", () => {
  const chatInput: ChatInput = { project: { title: "t", purpose: "", audience: "", constraints: "" }, askerName: null, today: null, memory: null, history: [], knowledge: [], question: "q" };
  const okBody = JSON.stringify({
    status: "completed",
    model: "gpt-6.1-terra",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ answer: "답", used_refs: [] }) }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("호출자가 시간 초과로 포기하면 진행 중인 요청을 끊고 다시 시도하지 않는다", async () => {
    let calls = 0;
    let aborted = 0;
    // 응답하지 않는 모델 서버: 요청이 취소될 때까지 기다린다
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted += 1; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
    }) as unknown as typeof fetch;
    const provider = new OpenAiProvider({ apiKey: "k", attemptTimeoutMs: 150, fetchImpl });

    await expect(withTimeout((signal) => provider.chat(chatInput, { signal }), 50)).rejects.toBeInstanceOf(AiTimeout);
    expect(aborted).toBe(1); // 시간 초과와 함께 요청이 끊겼다
    await sleep(900); // 예전에는 이 사이에 두 번째·세 번째 시도가 나갔다 (시도 제한 0.15초 + 대기 0.5초)
    expect(calls).toBe(1);
  });

  it("재시도를 기다리는 중에 시간 초과가 나면 다음 시도를 보내지 않는다", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "server error" } }), { status: 500 });
    }) as unknown as typeof fetch;
    const provider = new OpenAiProvider({ apiKey: "k", fetchImpl });

    await expect(withTimeout((signal) => provider.chat(chatInput, { signal }), 100)).rejects.toBeInstanceOf(AiTimeout);
    await sleep(800); // 예전에는 0.5초 뒤 두 번째 시도가 나갔다
    expect(calls).toBe(1);
  });

  it("시간 안에 끝나면 결과를 돌려주고, 취소 신호가 없어도 예전처럼 동작한다", async () => {
    const fetchImpl = (async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAiProvider({ apiKey: "k", fetchImpl });
    expect(await withTimeout((signal) => provider.chat(chatInput, { signal }), 1000)).toEqual({ answer: "답", used_refs: [] });
    expect(await provider.chat(chatInput)).toEqual({ answer: "답", used_refs: [] });
  });

  it("응답 본문을 읽다가 끊기면 네트워크 오류로 보고 다시 시도한다", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        // 머리말은 왔지만 본문이 중간에 끊긴 응답
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } }), { status: 200 });
      }
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAiProvider({ apiKey: "k", fetchImpl });
    expect(await provider.chat(chatInput)).toEqual({ answer: "답", used_refs: [] });
    expect(calls).toBe(2);
  });
});
