// 배포 확인: 배포된 주소가 기대한 커밋으로 바뀌었고, 들어갈 수 있는 상태인지 본다.
// 계정을 만들지 않고 모델도 부르지 않으므로 병합할 때마다 돌려도 된다 (.github/workflows/deploy-check.yml).
// 가입부터 대화까지 전체 흐름은 `npm run smoke` 가 본다.
//
//   npm run deploy:check -- --url=https://<배포 주소>
//   npm run deploy:check -- --url=https://<배포 주소> --commit=<커밋 해시> --wait=900
//
// 확인하는 것
//  1. /api/health 의 배포 커밋이 --commit 과 같아질 때까지 기다린다 (새 배포가 올라왔는지)
//  2. DB 연결과 마이그레이션 적용 (/api/health 가 ok)
//  3. 로그인 경로가 서버 오류 없이 응답하는지: 없는 코드·없는 이메일로 로그인하면 401 이어야 한다.
//     2026-11-10 장애에서는 상태 점검이 200 인데 이 요청이 500 이었다.
// 프록시 뒤(클라우드 세션)에서는 NODE_USE_ENV_PROXY=1 을 붙인다.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Health = { ok?: unknown; db?: unknown; pendingMigrations?: unknown; commit?: unknown };
export type HealthVerdict = { state: "ready" | "waiting" | "failed"; message: string };

/**
 * 상태 점검 응답을 판정한다.
 *  - ready: 다음 단계로 진행 · waiting: 새 배포를 기다리며 다시 확인 · failed: 기다려도 나아지지 않는 문제
 * expectedCommit 이 없으면 커밋은 보지 않는다. graceOver 는 "커밋을 알려주지 않는 배포본"을 더 기다리지 않을 때 true.
 */
export function judgeHealth(status: number, health: Health, expectedCommit: string | null, graceOver: boolean): HealthVerdict {
  const commit = typeof health.commit === "string" ? health.commit : null;
  if (expectedCommit) {
    const want = expectedCommit.slice(0, 7);
    if (commit && commit !== want) return { state: "waiting", message: `아직 이전 배포본입니다 (배포 ${commit}, 기대 ${want})` };
    if (!commit && !graceOver) return { state: "waiting", message: "배포본이 커밋을 알려주지 않습니다 (이전 버전이거나 Vercel 이 아님)" };
  }
  if (health.db === "migrations_pending") {
    const n = typeof health.pendingMigrations === "number" ? health.pendingMigrations : "?";
    return { state: "failed", message: `운영 DB 에 마이그레이션 ${n}개가 적용되지 않았습니다. 그 DB 에 \`npm run db:migrate\` 를 실행하세요.` };
  }
  if (status !== 200 || health.ok !== true) {
    // DB 가 잠들어 있다가 깨는 중일 수 있으므로 한동안은 다시 확인한다
    return { state: "waiting", message: `상태 점검 실패 (HTTP ${status}, db=${String(health.db)})` };
  }
  return { state: "ready", message: commit ? `배포 커밋 ${commit}, DB 정상` : "DB 정상 (배포 커밋은 확인하지 못함)" };
}

// 형식만 맞는 무작위 코드. 160비트 난수라 실제 계정의 코드와 겹치지 않는다.
function randomLoginCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const raw = Array.from(randomBytes(32), (b) => alphabet[b & 31]).join("");
  return `MJ-${raw.match(/.{4}/g)!.join("-")}`;
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"]; }));
  const base = (args.get("url") ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) {
    console.error("사용법: npm run deploy:check -- --url=https://<배포 주소> [--commit=<커밋 해시>] [--wait=<초>]");
    process.exit(2);
  }
  const expected = args.get("commit") && /^[0-9a-f]{7,40}$/.test(args.get("commit")!) ? args.get("commit")! : null;
  const waitSec = Number(args.get("wait") ?? (expected ? 600 : 60));
  const origin = new URL(base).origin;
  const call = async (method: string, p: string, body?: unknown) => {
    const headers: Record<string, string> = { Origin: origin };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* JSON 이 아닌 응답 */ }
    return { status: res.status, data };
  };

  console.log(`배포 확인: ${base}${expected ? ` (기대 커밋 ${expected.slice(0, 7)})` : ""}`);
  const started = Date.now();
  const GRACE_MS = 180_000; // 커밋을 알려주지 않는 배포본을 기다리는 시간
  let last = "";
  for (;;) {
    let verdict: HealthVerdict;
    try {
      const r = await call("GET", "/api/health");
      verdict = judgeHealth(r.status, r.data, expected, Date.now() - started > Math.min(GRACE_MS, waitSec * 1000));
    } catch (err) {
      verdict = { state: "waiting", message: `접속 실패 (${(err as Error).name})` };
    }
    if (verdict.message !== last) { console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${verdict.message}`); last = verdict.message; }
    if (verdict.state === "ready") break;
    if (verdict.state === "failed") { console.error(`✘ ${verdict.message}`); process.exit(1); }
    if (Date.now() - started > waitSec * 1000) {
      console.error(`✘ ${waitSec}초를 기다렸지만 정상이 되지 않았습니다: ${verdict.message}`);
      console.error("  Vercel 의 Deployments 에서 빌드가 실패했는지 확인하세요 (마이그레이션이 실패하면 빌드가 멈추고 이전 배포본이 남습니다).");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "✔" : "✘"} ${name}${ok ? "" : ` — ${detail}`}`);
    if (!ok) failures.push(name);
  };
  const schemaHint = "서버 오류입니다. 코드가 쓰는 열·표가 운영 DB 에 없을 수 있습니다 (마이그레이션 확인)";

  const prepared = await call("POST", "/api/auth/prepare", {});
  check("개인 로그인 코드 미리 받기 → 200", prepared.status === 200 && typeof prepared.data.registrationTicket === "string", `HTTP ${prepared.status}`);
  const byCode = await call("POST", "/api/auth/login", { loginCode: randomLoginCode() });
  check("없는 코드로 로그인 → 401", byCode.status === 401, byCode.status >= 500 ? `HTTP ${byCode.status}: ${schemaHint}` : `HTTP ${byCode.status}`);
  const byEmail = await call("POST", "/api/auth/login", { email: "deploy-check@example.invalid", password: "not-a-real-password" });
  check("없는 이메일로 로그인 → 401", byEmail.status === 401, byEmail.status >= 500 ? `HTTP ${byEmail.status}: ${schemaHint}` : `HTTP ${byEmail.status}`);
  const me = await call("GET", "/api/auth/me");
  check("로그인 없이 내 정보 → 401", me.status === 401, `HTTP ${me.status}`);

  if (failures.length) {
    console.error(`✘ 배포 확인 실패: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("✔ 배포 확인 통과 (계정을 만들지 않는 확인입니다. 전체 흐름은 npm run smoke)");
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`✘ 배포 확인을 마치지 못했습니다: ${(err as Error).message}`);
    process.exit(1);
  });
}
