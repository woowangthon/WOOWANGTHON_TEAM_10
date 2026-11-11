import { afterAll, beforeEach } from "vitest";
import { closePool, getPool } from "../src/lib/db.ts";
import { signUp } from "../src/lib/auth.ts";
import { assertTestDatabase } from "./db-guard.ts";

process.env.DATABASE_URL ??= "postgres://mijuk:devpass@localhost/mijuk_test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret-123";

export function useCleanDb() {
  assertTestDatabase(process.env.DATABASE_URL);
  beforeEach(async () => {
    await getPool().query(
      "truncate consumed_auth_tickets, audit_log, chat_memories, note_sources, reactions, advice_items, advice_requests, note_versions, notes, tasks, memberships, teams, users cascade",
    );
  });
  afterAll(closePool);
}

let n = 0;
export async function makeUser(name = "user") {
  n += 1;
  const { userId } = await signUp({ email: `${name}${n}@example.com`, password: "correct-horse-battery", displayName: name });
  return userId;
}

export const restated = (summary: string) => ({
  summary,
  kind: "guess" as const,
  conditions: [],
  uncertainties: ["측정 조건 미확인"],
  clarifying_question: null,
});

import type { AdviseInput, AiProvider, ChatInput, JudgeInput, RecapInput, RestateInput, SummarizeInput } from "../src/lib/ai/types.ts";

/** 제공자에 들어간 입력을 기록한다 (모델에 무엇이 전달되는지 검사용). */
export function recording(p: AiProvider) {
  const calls = { restate: [] as RestateInput[], judge: [] as JudgeInput[], advise: [] as AdviseInput[], chat: [] as ChatInput[], summarize: [] as SummarizeInput[], recap: [] as RecapInput[] };
  const provider: AiProvider = {
    name: p.name,
    isAi: p.isAi,
    restate: (i, o) => (calls.restate.push(i), p.restate(i, o)),
    judge: (i, o) => (calls.judge.push(i), p.judge(i, o)),
    advise: (i, o) => (calls.advise.push(i), p.advise(i, o)),
    chat: (i, o) => (calls.chat.push(i), p.chat(i, o)),
    summarize: (i, o) => (calls.summarize.push(i), p.summarize(i, o)),
    recap: (i, o) => (calls.recap.push(i), p.recap(i, o)),
  };
  return { provider, calls };
}
