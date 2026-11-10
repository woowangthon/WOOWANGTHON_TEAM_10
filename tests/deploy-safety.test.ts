// 2026-11-10 운영 장애(새 마이그레이션이 운영 DB 에 없는 채로 배포됨)의 재발을 막는 장치들.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { judgeHealth } from "../scripts/deploy-check.ts";
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
    expect(judgeHealth(200, { ok: true, db: "ok", pendingMigrations: 0, commit: "9caa8ae" }, sha, false).state).toBe("ready");
    expect(judgeHealth(200, { ok: true, db: "ok" }, null, false).state).toBe("ready");
  });

  it("아직 이전 커밋이면 기다린다", () => {
    const v = judgeHealth(200, { ok: true, db: "ok", commit: "ee9ecf9" }, sha, false);
    expect(v.state).toBe("waiting");
    expect(v.message).toContain("ee9ecf9");
  });

  it("마이그레이션이 빠져 있으면 기다리지 않고 실패한다", () => {
    const v = judgeHealth(503, { ok: false, db: "migrations_pending", pendingMigrations: 2, commit: "9caa8ae" }, sha, false);
    expect(v.state).toBe("failed");
    expect(v.message).toContain("2개");
  });

  it("커밋을 알려주지 않는 배포본은 잠시 기다린 뒤 DB 상태만으로 판정한다", () => {
    expect(judgeHealth(200, { ok: true, db: "ok" }, sha, false).state).toBe("waiting");
    expect(judgeHealth(200, { ok: true, db: "ok" }, sha, true).state).toBe("ready");
  });

  it("DB 연결 실패는 깨어나는 중일 수 있으므로 다시 확인한다", () => {
    expect(judgeHealth(503, { ok: false, db: "error", commit: "9caa8ae" }, sha, false).state).toBe("waiting");
  });
});
