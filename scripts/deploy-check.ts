// 배포 확인: 배포된 주소가 기대한 커밋으로 바뀌었고, 들어갈 수 있는 상태인지 본다.
// 계정을 만들지 않고 모델도 부르지 않으므로 병합할 때마다 돌려도 된다 (.github/workflows/deploy-check.yml).
// 가입부터 대화까지 전체 흐름은 `npm run smoke` 가 본다.
//
//   npm run deploy:check -- --url=https://<배포 주소>
//   npm run deploy:check -- --url=https://<배포 주소> --commit=<커밋 해시> --wait=900
//
// 확인하는 것
//  1. --commit 을 주면 /api/health 의 배포 커밋이 그 커밋과 같아질 때까지 기다린다. **같아지지 않으면 실패한다.**
//     커밋을 알려 주지 않는 배포본(Vercel 이 아니거나 시스템 환경변수가 꺼진 경우)은 --commit 없이 확인한다.
//  2. DB 연결과 마이그레이션 적용 (/api/health 가 ok)
//  3. 로그인 경로가 서버 오류 없이 응답하는지: 없는 코드·없는 이메일로 로그인하면 401 이어야 한다.
//     2026-11-10 장애에서는 상태 점검이 200 인데 이 요청이 500 이었다.
// 시간 제한: --wait 은 새 배포를 기다리는 전체 시간이다. 요청 하나하나에도 제한이 있어서(--timeout, 기본 10초),
// 서버가 응답을 시작만 하고 멈춰도 --wait 을 넘겨 기다리지 않는다.
// 프록시 뒤(클라우드 세션)에서는 NODE_USE_ENV_PROXY=1 을 붙인다.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Health = { ok?: unknown; db?: unknown; pendingMigrations?: unknown; commit?: unknown };
export type HealthVerdict = { state: "ready" | "waiting" | "failed"; message: string };

/**
 * 상태 점검 응답을 판정한다.
 *  - ready: 다음 단계로 진행 · waiting: 다시 확인 · failed: 기다려도 나아지지 않는 문제
 * expectedCommit 을 주면 배포본이 알려 준 커밋이 그것과 같을 때만 ready 다.
 * 커밋을 알려 주지 않는 배포본은 "확인하지 못함"이지 "같음"이 아니므로, 기다리다가 제한 시간에 실패한다.
 */
export function judgeHealth(status: number, health: Health, expectedCommit: string | null): HealthVerdict {
  const commit = typeof health.commit === "string" ? health.commit : null;
  if (expectedCommit) {
    const want = expectedCommit.slice(0, 7);
    if (!commit) return { state: "waiting", message: `배포본이 커밋을 알려 주지 않아 기대한 커밋(${want})인지 확인할 수 없습니다` };
    if (commit !== want) return { state: "waiting", message: `아직 이전 배포본입니다 (배포 ${commit}, 기대 ${want})` };
  }
  if (health.db === "migrations_pending") {
    const n = typeof health.pendingMigrations === "number" ? health.pendingMigrations : "?";
    return { state: "failed", message: `운영 DB 에 마이그레이션 ${n}개가 적용되지 않았습니다. 그 DB 에 \`npm run db:migrate\` 를 실행하세요.` };
  }
  if (status !== 200 || health.ok !== true) {
    // DB 가 잠들어 있다가 깨는 중일 수 있으므로 한동안은 다시 확인한다
    return { state: "waiting", message: `상태 점검 실패 (HTTP ${status}, db=${String(health.db)})` };
  }
  return { state: "ready", message: commit ? `배포 커밋 ${commit}, DB 정상` : "DB 정상 (배포 커밋은 확인하지 않음)" };
}

/**
 * 요청 하나를 보내고 JSON 응답을 읽는다. timeoutMs 는 응답 머리말과 **본문을 다 읽을 때까지**에 걸린다.
 * 서버가 머리말만 보내고 본문을 끝내지 않아도 이 시간이 지나면 실패한다.
 */
export async function request(base: string, method: string, pathname: string, body: unknown, timeoutMs: number) {
  const headers: Record<string, string> = { Origin: new URL(base).origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* JSON 이 아닌 응답 */ }
  return { status: res.status, data };
}

// 형식만 맞는 무작위 코드. 160비트 난수라 실제 계정의 코드와 겹치지 않는다.
function randomLoginCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const raw = Array.from(randomBytes(32), (b) => alphabet[b & 31]).join("");
  return `MJ-${raw.match(/.{4}/g)!.join("-")}`;
}

export type DeployCheckOptions = {
  url: string;
  /** 기대하는 배포 커밋. 주면 그 커밋이 배포됐을 때만 통과한다 */
  commit?: string | null;
  /** 새 배포와 정상 상태를 기다리는 전체 시간(초) */
  waitSec?: number;
  /** 요청 하나의 제한 시간(밀리초) */
  requestTimeoutMs?: number;
  /** 다시 확인하는 간격(밀리초) */
  pollMs?: number;
  log?: (line: string) => void;
};
export type DeployCheckResult = { ok: boolean; reason: string };

const failureOf = (err: unknown) => {
  const name = (err as Error)?.name ?? "Error";
  return name === "TimeoutError" || name === "AbortError" ? "응답 없음 (요청 제한 시간 초과)" : `접속 실패 (${name})`;
};

export async function deployCheck(opts: DeployCheckOptions): Promise<DeployCheckResult> {
  const base = opts.url.replace(/\/$/, "");
  const expected = opts.commit && /^[0-9a-f]{7,40}$/.test(opts.commit) ? opts.commit : null;
  const waitMs = (opts.waitSec ?? (expected ? 600 : 60)) * 1000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 10_000;
  const log = opts.log ?? (() => {});
  const fail = (reason: string): DeployCheckResult => { log(`✘ ${reason}`); return { ok: false, reason }; };

  log(`배포 확인: ${base}${expected ? ` (기대 커밋 ${expected.slice(0, 7)})` : ""}`);
  const started = Date.now();
  const deadline = started + waitMs;
  let last = "";
  for (;;) {
    const remaining = deadline - Date.now();
    let verdict: HealthVerdict;
    try {
      // 남은 시간보다 오래 기다리지 않는다
      const r = await request(base, "GET", "/api/health", undefined, Math.max(1, Math.min(requestTimeoutMs, remaining)));
      verdict = judgeHealth(r.status, r.data, expected);
    } catch (err) {
      verdict = { state: "waiting", message: failureOf(err) };
    }
    if (verdict.message !== last) { log(`  [${Math.round((Date.now() - started) / 1000)}s] ${verdict.message}`); last = verdict.message; }
    if (verdict.state === "ready") break;
    if (verdict.state === "failed") return fail(verdict.message);
    // 한 번 더 확인할 시간(요청 하나 분량)이 남지 않았으면 여기서 끝낸다. 제한 시간을 넘겨 기다리지 않는다
    const left = deadline - Date.now();
    const reserve = Math.min(requestTimeoutMs, 1000);
    if (left <= reserve) {
      log("  Vercel 의 Deployments 에서 빌드가 실패했는지 확인하세요 (마이그레이션이 실패하면 빌드가 멈추고 이전 배포본이 남습니다).");
      if (expected) log("  커밋을 알려 주지 않는 배포본이라면 --commit 없이 실행하세요.");
      return fail(`${Math.round(waitMs / 1000)}초 안에 정상이 되지 않았습니다: ${verdict.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left - reserve)));
  }

  const failures: string[] = [];
  const probe = async (name: string, method: string, pathname: string, body: unknown, passes: (r: { status: number; data: Record<string, unknown> }) => boolean, serverErrorHint = "") => {
    let detail: string;
    try {
      const r = await request(base, method, pathname, body, requestTimeoutMs);
      if (passes(r)) { log(`  ✔ ${name}`); return; }
      detail = r.status >= 500 && serverErrorHint ? `HTTP ${r.status}: ${serverErrorHint}` : `HTTP ${r.status}`;
    } catch (err) {
      detail = failureOf(err);
    }
    log(`  ✘ ${name} — ${detail}`);
    failures.push(name);
  };
  const schemaHint = "서버 오류입니다. 코드가 쓰는 열·표가 운영 DB 에 없을 수 있습니다 (마이그레이션 확인)";
  await probe("개인 로그인 코드 미리 받기 → 200", "POST", "/api/auth/prepare", {}, (r) => r.status === 200 && typeof r.data.registrationTicket === "string");
  await probe("없는 코드로 로그인 → 401", "POST", "/api/auth/login", { loginCode: randomLoginCode() }, (r) => r.status === 401, schemaHint);
  await probe("없는 이메일로 로그인 → 401", "POST", "/api/auth/login", { email: "deploy-check@example.invalid", password: "not-a-real-password" }, (r) => r.status === 401, schemaHint);
  await probe("로그인 없이 내 정보 → 401", "GET", "/api/auth/me", undefined, (r) => r.status === 401);

  if (failures.length) return fail(`배포 확인 실패: ${failures.join(", ")}`);
  log("✔ 배포 확인 통과 (계정을 만들지 않는 확인입니다. 전체 흐름은 npm run smoke)");
  return { ok: true, reason: "" };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"]; }));
  const url = args.get("url") ?? "";
  const number = (key: string) => { const n = Number(args.get(key)); return args.has(key) && Number.isFinite(n) && n > 0 ? n : undefined; };
  const commit = args.get("commit");
  if (!/^https?:\/\//.test(url)) {
    console.error("사용법: npm run deploy:check -- --url=https://<배포 주소> [--commit=<커밋 해시>] [--wait=<초>] [--timeout=<요청 제한 초>]");
    process.exit(2);
  }
  if (commit !== undefined && !/^[0-9a-f]{7,40}$/.test(commit)) {
    // 잘못 적은 커밋을 조용히 무시하면 커밋을 확인하지 않고 통과시키게 된다
    console.error(`--commit 값이 커밋 해시가 아닙니다: ${commit}`);
    process.exit(2);
  }
  deployCheck({ url, commit, waitSec: number("wait"), requestTimeoutMs: number("timeout") ? number("timeout")! * 1000 : undefined, log: (line) => console.log(line) }).then(
    (result) => process.exit(result.ok ? 0 : 1),
    (err) => {
      console.error(`✘ 배포 확인을 마치지 못했습니다: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
