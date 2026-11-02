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
