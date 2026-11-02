import { afterAll, beforeEach } from "vitest";
import { closePool, getPool } from "../src/lib/db.ts";
import { signUp } from "../src/lib/auth.ts";

process.env.DATABASE_URL ??= "postgres://mijuk:devpass@localhost/mijuk_test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret-123";

export function useCleanDb() {
  beforeEach(async () => {
    await getPool().query(
      "truncate audit_log, reactions, advice_items, advice_requests, note_versions, notes, tasks, memberships, teams, users cascade",
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

import type { AdviseInput, AiProvider, JudgeInput, RestateInput } from "../src/lib/ai/types.ts";

/** 제공자에 들어간 입력을 기록한다 (모델에 무엇이 전달되는지 검사용). */
export function recording(p: AiProvider) {
  const calls = { restate: [] as RestateInput[], judge: [] as JudgeInput[], advise: [] as AdviseInput[] };
  const provider: AiProvider = {
    name: p.name,
    isAi: p.isAi,
    restate: (i) => (calls.restate.push(i), p.restate(i)),
    judge: (i) => (calls.judge.push(i), p.judge(i)),
    advise: (i) => (calls.advise.push(i), p.advise(i)),
  };
  return { provider, calls };
}
