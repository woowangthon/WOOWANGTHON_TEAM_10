import { describe, expect, it } from "vitest";
import { issueSession, logIn, readSession, signUp } from "../src/lib/auth.ts";
import { getPool } from "../src/lib/db.ts";
import { useCleanDb } from "./helpers.ts";

useCleanDb();

describe("인증", () => {
  it("비밀번호는 평문으로 저장하지 않는다", async () => {
    await signUp({ email: "a@example.com", password: "correct-horse-battery", displayName: "A" });
    const r = await getPool().query("select password_hash from users");
    expect(r.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(r.rows[0].password_hash).not.toContain("correct-horse");
  });

  it("틀린 비밀번호와 없는 계정은 같은 오류를 낸다", async () => {
    await signUp({ email: "a@example.com", password: "correct-horse-battery", displayName: "A" });
    const wrong = await logIn({ email: "a@example.com", password: "wrong-password!!" }).catch((e) => e);
    const missing = await logIn({ email: "nobody@example.com", password: "wrong-password!!" }).catch((e) => e);
    expect(wrong.code).toBe("invalid_login");
    expect(missing.code).toBe("invalid_login");
    expect(wrong.message).toBe(missing.message);
  });

  it("짧은 비밀번호는 거부한다", async () => {
    await expect(signUp({ email: "b@example.com", password: "short", displayName: "B" })).rejects.toThrow();
  });

  it("위조·만료된 세션은 거부한다", () => {
    const token = issueSession("11111111-1111-1111-1111-111111111111");
    expect(readSession(token)).toBe("11111111-1111-1111-1111-111111111111");
    const forged = token.replace(/^[^.]+/, "22222222-2222-2222-2222-222222222222");
    expect(readSession(forged)).toBeNull();
    expect(readSession(token, Date.now() + 8 * 24 * 3600 * 1000)).toBeNull();
    expect(readSession("garbage")).toBeNull();
  });
});
