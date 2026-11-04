import { describe, expect, it } from "vitest";
import { getAdvice, listAdviceRequests, requestAdvice } from "../src/lib/advice.ts";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import { getPool } from "../src/lib/db.ts";
import { rateLimit, resetRateLimits, trackedRateLimitKeys } from "../src/lib/http.ts";
import { confirmVersion, createNote, shareNote } from "../src/lib/notes.ts";
import { checkDatabase, checkEnvironment } from "../src/lib/startup.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, getInviteCode, getTeam, joinTeam, leaveTeam, listMyTeams, rotateInviteCode } from "../src/lib/teams.ts";
import { assertTestDatabase } from "./db-guard.ts";
import { makeUser, recording, useCleanDb } from "./helpers.ts";

useCleanDb();

describe("실수 방지 안전장치", () => {
  it("테스트는 이름에 test 가 없는 DB 를 비우지 않는다", () => {
    expect(() => assertTestDatabase("postgres://u:p@host/mijuk_prod", {})).toThrow(/모든 표를 비웁니다/);
    expect(() => assertTestDatabase(undefined, {})).toThrow();
    expect(() => assertTestDatabase("not a url", {})).toThrow();
    expect(assertTestDatabase("postgres://u:p@host/mijuk_test", {})).toBe("mijuk_test");
    expect(assertTestDatabase("postgres://u:p@host/mijuk_prod", { ALLOW_TEST_DB_TRUNCATE: "1" })).toBe("mijuk_prod");
  });

  it("시작 시 설정 검사: 빠진 값·예시 값·공개 변수에 든 비밀을 잡아낸다", () => {
    const good = { DATABASE_URL: "postgres://x", SESSION_SECRET: "k".repeat(40), NODE_ENV: "production" };
    expect(checkEnvironment(good)).toEqual([]);
    const fatal = (env: Record<string, string | undefined>) => checkEnvironment(env).filter((p) => p.fatal).map((p) => p.message);

    expect(fatal({ ...good, DATABASE_URL: undefined }).join()).toContain("DATABASE_URL");
    expect(fatal({ ...good, DATABASE_URL: "mysql://x" }).join()).toContain("postgres://");
    expect(fatal({ ...good, SESSION_SECRET: "short" }).join()).toContain("32자");
    expect(fatal({ ...good, SESSION_SECRET: "test-secret-test-secret-test-secret-123" }).join()).toContain("예시 값");
    expect(fatal({ ...good, AI_PROVIDER: "gpt" }).join()).toContain("AI_PROVIDER");
    expect(fatal({ ...good, AI_PROVIDER: "fake" }).join()).toContain("운영 환경");
    expect(fatal({ ...good, NODE_ENV: "development", AI_PROVIDER: "fake" })).toEqual([]);
    expect(fatal({ ...good, NEXT_PUBLIC_API_KEY: "x" }).join()).toContain("NEXT_PUBLIC_");
    expect(fatal({ ...good, NODE_TLS_REJECT_UNAUTHORIZED: "0" }).join()).toContain("TLS");
    const warn = checkEnvironment({ ...good, AI_TIMEOUT_MS: "5" });
    expect(warn).toHaveLength(1);
    expect(warn[0]!.fatal).toBe(false);
  });

  it("DB 점검은 마이그레이션 적용 여부를 알려준다", async () => {
    const r = await checkDatabase();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("마이그레이션");
  });
});

describe("요청 횟수 제한", () => {
  it("한도를 넘으면 429, 시간이 지나면 풀리고, 만료된 키는 메모리에서 지운다", () => {
    resetRateLimits();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) rateLimit("k", 3, 1000, t0);
    expect(() => rateLimit("k", 3, 1000, t0 + 10)).toThrow(/시도가 너무 많습니다/);
    expect(() => rateLimit("k", 3, 1000, t0 + 2000)).not.toThrow();
    for (let i = 0; i < 500; i++) rateLimit(`ip${i}`, 3, 1000, t0 + 2000);
    expect(trackedRateLimitKeys()).toBeGreaterThan(500);
    rateLimit("later", 3, 1000, t0 + 2000 + 61_000 + 1000); // 1분 뒤 정리
    expect(trackedRateLimitKeys()).toBe(1);
    resetRateLimits();
  });
});

describe("팀 운영", () => {
  it("유일한 팀장이 나가면 가장 오래된 팀원이 팀장이 된다", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const carol = await makeUser("carol");
    const team = await createTeam(alice, "A팀");
    await joinTeam(bob, team.inviteCode);
    await joinTeam(carol, team.inviteCode);
    const r = await leaveTeam(alice, team.id);
    expect(r.promoted).toEqual({ displayName: "bob" });
    const info = await getTeam(bob, team.id);
    expect(info.myRole).toBe("lead");
    expect(info.members.map((m) => [m.displayName, m.role])).toEqual([["bob", "lead"], ["carol", "member"]]);
    expect(await getInviteCode(bob, team.id)).toBe(team.inviteCode);
    await expect(getTeam(alice, team.id)).rejects.toMatchObject({ status: 404 });
    // 혼자 남은 팀원이 나가는 것도 막지 않는다
    await leaveTeam(carol, team.id);
    expect((await leaveTeam(bob, team.id)).promoted).toBeNull();
  });

  it("팀 정보에는 이메일이 없고, 팀원 수가 목록에 나온다", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const team = await createTeam(alice, "A팀");
    await joinTeam(bob, team.inviteCode);
    const info = await getTeam(bob, team.id);
    expect(JSON.stringify(info)).not.toContain("@");
    expect(info.members.find((m) => m.isMe)?.displayName).toBe("bob");
    expect((await listMyTeams(bob))[0]!.member_count).toBe(2);
  });

  it("초대 코드 재발급은 팀장만 할 수 있고, 옛 코드는 바로 무효가 된다", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const mallory = await makeUser("mallory");
    const team = await createTeam(alice, "A팀");
    await joinTeam(bob, team.inviteCode);
    await expect(rotateInviteCode(bob, team.id)).rejects.toMatchObject({ status: 404 });
    const { inviteCode } = await rotateInviteCode(alice, team.id);
    expect(inviteCode).not.toBe(team.inviteCode);
    await expect(joinTeam(mallory, team.inviteCode)).rejects.toMatchObject({ status: 404 });
    await joinTeam(mallory, inviteCode);
    expect((await getTeam(alice, team.id)).members).toHaveLength(3);
  });
});

describe("조언 요청 정리", () => {
  async function setup() {
    const alice = await makeUser("alice");
    const team = await createTeam(alice, "A팀");
    const n = await createNote(alice, team.id, { rawText: "두 실험은   측정 조건이\n달라 보임" });
    await confirmVersion(alice, n.noteId, n.versionId, { choice: "raw_only", expectedHash: n.contentHash });
    await shareNote(alice, n.noteId, n.versionId);
    const task = await createTask(alice, team.id, { title: "측정 조건 발표" });
    return { alice, teamId: team.id, taskId: task.id as string, n };
  }

  it("5분 넘게 '처리 중' 인 요청은 실패로 정리된다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.alice, s.taskId, {}, noAiProvider);
    await getPool().query("update advice_requests set status = 'pending', created_at = now() - interval '6 minutes' where id = $1", [a.id]);
    const again = await getAdvice(s.alice, a.id);
    expect([again.status, again.error]).toEqual(["failed", "stale"]);
    expect((await listAdviceRequests(s.alice, s.taskId))[0]!.status).toBe("failed");
    const row = await getPool().query("select status, error from advice_requests where id = $1", [a.id]);
    expect(row.rows[0]).toEqual({ status: "failed", error: "stale" });
  });

  it("키워드 항목의 인용은 공백을 정리해 원문 안에서 찾을 수 있다", async () => {
    const s = await setup();
    const a = await requestAdvice(s.alice, s.taskId, {}, noAiProvider);
    const item = a.items[0]!;
    expect(item.keywordOnly).toBe(true);
    const ev = item.evidence[0]!;
    expect(ev.available && ev.quote).toBe("두 실험은 측정 조건이 달라 보임");
    expect(ev.available && ev.text.replace(/\s+/g, " ")).toContain(ev.available ? ev.quote! : "");
  });

  it("AI 모드에서 AI 처리를 허용하지 않은 메모는 모델에 가지 않고 키워드 항목으로만 보인다", async () => {
    const s = await setup();
    const priv = await createNote(s.alice, s.teamId, { rawText: "측정 조건 관련 민감한 내부 사정", allowExternalAi: false });
    await confirmVersion(s.alice, priv.noteId, priv.versionId, { choice: "raw_only", expectedHash: priv.contentHash });
    await shareNote(s.alice, priv.noteId, priv.versionId);
    const { provider, calls } = recording(new FakeProvider());
    const a = await requestAdvice(s.alice, s.taskId, {}, provider);
    expect(JSON.stringify(calls)).not.toContain("민감한");
    const local = a.items.filter((i) => i.keywordOnly);
    expect(local).toHaveLength(1);
    expect(local[0]!.section).toBe("direct");
    expect(local[0]!.evidence[0]!.available && local[0]!.evidence[0]!.text).toContain("민감한");
    expect(a.items.filter((i) => !i.keywordOnly).length).toBeGreaterThan(0);
  });
});
