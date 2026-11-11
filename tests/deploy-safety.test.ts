// 2026-11-10 운영 장애(새 마이그레이션이 운영 DB 에 없는 채로 배포됨)의 재발을 막는 장치들.
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { deployCheck, judgeHealth, request } from "../scripts/deploy-check.ts";
import { migrate } from "../scripts/migrate.ts";
import { deployMigrationPlan } from "../scripts/predeploy.ts";
import { closePool } from "../src/lib/db.ts";
import { errorSummary } from "../src/lib/http.ts";
import { pendingMigrations, REQUIRED_MIGRATIONS } from "../src/lib/schema-version.ts";
import { checkDatabase } from "../src/lib/startup.ts";
import { assertTestDatabase } from "./db-guard.ts";
import "./helpers.ts"; // DATABASE_URL·SESSION_SECRET 기본값

afterAll(closePool);

describe("코드가 요구하는 마이그레이션", () => {
  it("요구 목록은 db/migrations 폴더의 파일과 같다 (마이그레이션을 추가하면 목록에도 추가해야 한다)", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
    expect([...REQUIRED_MIGRATIONS]).toEqual(files);
  });

  it("빠진 마이그레이션을 파일명 순서로 알려준다", () => {
    expect(pendingMigrations(REQUIRED_MIGRATIONS)).toEqual([]);
    const upTo007 = REQUIRED_MIGRATIONS.filter((name) => name < "008");
    expect(pendingMigrations(upTo007)).toEqual(["008_email_free_accounts.sql", "009_consumed_auth_tickets.sql"]);
    // DB 가 코드보다 앞서 있는 것(되돌린 배포)은 빠진 것이 아니다
    expect(pendingMigrations([...REQUIRED_MIGRATIONS, "999_future.sql"])).toEqual([]);
  });
});

describe("DB 점검", () => {
  it("요구하는 마이그레이션이 모두 적용돼 있으면 정상", async () => {
    const r = await checkDatabase();
    expect(r).toMatchObject({ ok: true, state: "ok", pending: [] });
    expect(r.message).toContain(`마이그레이션 ${REQUIRED_MIGRATIONS.length}개`);
  });

  it("연결은 되지만 요구하는 마이그레이션이 빠져 있으면 정상이 아니다", async () => {
    const r = await checkDatabase([...REQUIRED_MIGRATIONS, "999_not_applied.sql"]);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("migrations_pending");
    expect(r.pending).toEqual(["999_not_applied.sql"]);
    expect(r.message).toContain("999_not_applied.sql");
    expect(r.message).toContain("db:migrate");
  });
});

describe("마이그레이션 실행기", () => {
  it("이미 적용된 DB 에 다시 돌려도, 동시에 두 번 돌려도 아무것도 다시 적용하지 않는다", async () => {
    const url = process.env.DATABASE_URL!;
    assertTestDatabase(url);
    await migrate(url); // 테스트 DB 가 뒤처져 있었다면 여기서 맞춘다
    expect(await migrate(url)).toEqual([]);
    expect(await Promise.all([migrate(url), migrate(url)])).toEqual([[], []]);
    expect((await checkDatabase()).ok).toBe(true);
  });
});

describe("운영 배포 전 마이그레이션", () => {
  it("Vercel 운영 배포에서만 적용한다", () => {
    expect(deployMigrationPlan({ VERCEL: "1", VERCEL_ENV: "production" }).run).toBe(true);
    // 미리보기 배포(병합 전 브랜치)·개발·로컬·CI 는 운영 DB 를 건드리지 않는다
    expect(deployMigrationPlan({ VERCEL: "1", VERCEL_ENV: "preview" }).run).toBe(false);
    expect(deployMigrationPlan({ VERCEL: "1", VERCEL_ENV: "development" }).run).toBe(false);
    expect(deployMigrationPlan({}).run).toBe(false);
    expect(deployMigrationPlan({ CI: "true" }).run).toBe(false);
  });

  it("건너뛰기 설정을 켜면 운영 배포에서도 적용하지 않고 이유를 알려준다", () => {
    const plan = deployMigrationPlan({ VERCEL_ENV: "production", SKIP_DEPLOY_MIGRATIONS: "1" });
    expect(plan.run).toBe(false);
    expect(plan.reason).toContain("db:migrate");
  });
});

describe("운영 오류 로그", () => {
  it("DB 오류는 오류 코드를 남기고, 없는 열·표는 마이그레이션을 확인하라고 알려준다", () => {
    const undefinedColumn = Object.assign(new Error('column "login_code_hash" does not exist'), { name: "error", code: "42703" });
    const summary = errorSummary(undefinedColumn);
    expect(summary).toContain("42703");
    expect(summary).toContain("마이그레이션");
    expect(errorSummary(Object.assign(new Error("relation does not exist"), { name: "error", code: "42P01" }))).toContain("마이그레이션");
    expect(errorSummary(Object.assign(new Error("duplicate key"), { name: "error", code: "23505" }))).toBe("error 23505");
  });

  it("오류 메시지·본문은 남기지 않는다", () => {
    const withContent = Object.assign(new Error("비밀 메모 내용이 든 메시지"), { name: "error", code: "42703", detail: "비밀 상세" });
    expect(errorSummary(withContent)).not.toContain("비밀");
    expect(errorSummary(new TypeError("비밀 값"))).toBe("TypeError");
    // 다섯 글자 코드 형식이 아니면 코드로 남기지 않는다
    expect(errorSummary(Object.assign(new Error("x"), { code: "비밀이 섞인 긴 코드 값" }))).toBe("Error");
    expect(errorSummary("문자열 오류")).toBe("Error");
    expect(errorSummary(null)).toBe("Error");
  });
});

describe("배포 확인의 상태 판정", () => {
  const sha = "9caa8ae770ac4ec7bc74638f6ba48f3a1fe6bc57";

  it("기대한 커밋이 배포됐고 DB 가 정상이면 통과", () => {
    expect(judgeHealth(200, { ok: true, db: "ok", pendingMigrations: 0, commit: "9caa8ae" }, sha).state).toBe("ready");
    expect(judgeHealth(200, { ok: true, db: "ok" }, null).state).toBe("ready");
  });

  it("아직 이전 커밋이면 기다린다", () => {
    const v = judgeHealth(200, { ok: true, db: "ok", commit: "ee9ecf9" }, sha);
    expect(v.state).toBe("waiting");
    expect(v.message).toContain("ee9ecf9");
  });

  it("마이그레이션이 빠져 있으면 기다리지 않고 실패한다", () => {
    const v = judgeHealth(503, { ok: false, db: "migrations_pending", pendingMigrations: 2, commit: "9caa8ae" }, sha);
    expect(v.state).toBe("failed");
    expect(v.message).toContain("2개");
  });

  it("기대한 커밋이 있는데 배포본이 커밋을 알려 주지 않으면 통과시키지 않는다", () => {
    // 확인하지 못한 것은 같은 것이 아니다. 얼마를 기다려도 ready 가 되지 않는다
    expect(judgeHealth(200, { ok: true, db: "ok" }, sha).state).toBe("waiting");
    expect(judgeHealth(200, { ok: true, db: "ok", commit: null }, sha).state).toBe("waiting");
    expect(judgeHealth(200, { ok: true, db: "ok", commit: null }, sha).message).toContain("확인할 수 없습니다");
  });

  it("DB 연결 실패는 깨어나는 중일 수 있으므로 다시 확인한다", () => {
    expect(judgeHealth(503, { ok: false, db: "error", commit: "9caa8ae" }, sha).state).toBe("waiting");
  });
});

describe("배포 확인 실행", () => {
  const sha = "ed2bfe02052a87d19b9bd773e0fbc13e6749dd72";
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const servers: Server[] = [];
  /** 요청을 handler 로 처리하는 임시 서버의 주소 */
  const serve = async (handler: Handler) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterAll(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  /** 정상 배포본. health 와 codeLoginStatus 만 바꿔 여러 상태를 흉내 낸다 */
  const app = (health: Record<string, unknown>, codeLoginStatus = 401): Handler => (req, res) => {
    if (req.url === "/api/health") return json(res, health.ok ? 200 : 503, health);
    if (req.url === "/api/auth/prepare") return json(res, 200, { loginCode: "x", registrationTicket: "y" });
    if (req.url === "/api/auth/login") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => json(res, body.includes("loginCode") ? codeLoginStatus : 401, { error: "x" }));
      return;
    }
    return json(res, 401, { error: "unauthorized" });
  };
  const quick = { waitSec: 1, requestTimeoutMs: 300, pollMs: 100 };

  it("기대한 커밋이 배포됐고 로그인 경로가 정상이면 통과한다", async () => {
    const url = await serve(app({ ok: true, db: "ok", pendingMigrations: 0, commit: "ed2bfe0" }));
    expect(await deployCheck({ url, commit: sha, ...quick })).toEqual({ ok: true, reason: "" });
  });

  it("기대한 커밋을 지정했는데 배포본이 커밋을 알려 주지 않으면 실패한다", async () => {
    const url = await serve(app({ ok: true, db: "ok", pendingMigrations: 0, commit: null }));
    const result = await deployCheck({ url, commit: sha, ...quick });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("확인할 수 없습니다");
    // 커밋을 지정하지 않으면 같은 배포본을 DB 상태와 로그인 경로만으로 확인한다
    expect((await deployCheck({ url, ...quick })).ok).toBe(true);
  });

  it("다른 커밋이 배포돼 있으면 제한 시간 뒤 실패한다", async () => {
    const url = await serve(app({ ok: true, db: "ok", pendingMigrations: 0, commit: "9caa8ae" }));
    const result = await deployCheck({ url, commit: sha, ...quick });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("9caa8ae");
  });

  it("상태 점검은 정상인데 코드 로그인이 서버 오류면 실패한다 (2026-11-10 장애의 모습)", async () => {
    const url = await serve(app({ ok: true, db: "ok", pendingMigrations: 0, commit: "ed2bfe0" }, 500));
    const result = await deployCheck({ url, commit: sha, ...quick });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("없는 코드로 로그인");
  });

  it("응답 본문이 멈춰도 요청 제한 시간에 끊고, 기다리는 전체 시간을 넘기지 않는다", async () => {
    // 머리말과 본문 앞부분만 보내고 끝내지 않는 서버
    const url = await serve((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":'); });
    const started = Date.now();
    await expect(request(url, "GET", "/api/health", undefined, 200)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);

    const again = Date.now();
    const result = await deployCheck({ url, commit: sha, ...quick });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("응답 없음");
    expect(Date.now() - again).toBeLessThan(3000); // 제한 1초 + 여유. 예전에는 끝나지 않았다
  });
});
