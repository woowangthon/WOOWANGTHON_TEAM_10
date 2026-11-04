// 서버 시작 시 설정을 검사한다 (src/instrumentation.ts 에서 호출).
// 잘못된 설정은 요청마다 알 수 없는 500 오류를 내는 대신, 시작 단계에서 분명한 메시지로 멈추게 한다.
type Env = Record<string, string | undefined>;

export type StartupProblem = { fatal: boolean; message: string };

export function checkEnvironment(env: Env): StartupProblem[] {
  const problems: StartupProblem[] = [];
  const isProd = env.NODE_ENV === "production";

  if (!env.DATABASE_URL) {
    problems.push({ fatal: true, message: "DATABASE_URL 이 설정되지 않았습니다. PostgreSQL 접속 주소를 넣어 주세요." });
  } else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
    problems.push({ fatal: true, message: "DATABASE_URL 은 postgres:// 로 시작해야 합니다." });
  }

  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32) {
    problems.push({
      fatal: true,
      message: "SESSION_SECRET 은 32자 이상이어야 합니다. 예: openssl rand -base64 36 으로 만든 값을 넣어 주세요.",
    });
  } else if (/^(test|dev|change|example|secret)/i.test(secret) && isProd) {
    problems.push({ fatal: true, message: "SESSION_SECRET 이 예시 값처럼 보입니다. 운영 환경에서는 무작위 값을 써야 합니다." });
  }

  const provider = (env.AI_PROVIDER ?? "none").trim();
  if (!["", "none", "fake", "openai"].includes(provider)) {
    problems.push({ fatal: true, message: `AI_PROVIDER 값 "${provider}" 은 지원하지 않습니다. none | fake | openai 중 하나여야 합니다.` });
  } else if (provider === "fake" && (isProd || env.VERCEL)) {
    problems.push({ fatal: true, message: "AI_PROVIDER=fake 는 운영 환경(또는 Vercel)에서 쓸 수 없습니다. none 으로 바꿔 주세요." });
  } else if (provider === "openai") {
    if (!env.OPENAI_API_KEY?.trim()) {
      problems.push({
        fatal: false,
        message: "OPENAI_API_KEY 가 환경변수에 없습니다. 프록시가 키를 주입하는 개발 환경이 아니면 AI 호출이 실패합니다.",
      });
    }
    const effort = (env.OPENAI_REASONING_EFFORT ?? "none").trim();
    if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
      problems.push({ fatal: false, message: `OPENAI_REASONING_EFFORT 값 "${effort}" 은 지원하지 않습니다. none 을 씁니다.` });
    }
  }
  if (provider !== "openai" && env.OPENAI_API_KEY) {
    problems.push({ fatal: false, message: "OPENAI_API_KEY 가 있지만 AI_PROVIDER 가 openai 가 아니라 쓰이지 않습니다." });
  }

  if (env.AI_TIMEOUT_MS !== undefined) {
    const n = Number(env.AI_TIMEOUT_MS);
    if (!Number.isFinite(n) || n < 1000 || n > 120_000)
      problems.push({ fatal: false, message: "AI_TIMEOUT_MS 는 1000~120000 사이여야 합니다. 기본값 30000 을 씁니다." });
  }

  for (const key of Object.keys(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && /KEY|SECRET|TOKEN|PASSWORD|DATABASE/i.test(key)) {
      problems.push({ fatal: true, message: `${key}: NEXT_PUBLIC_ 변수는 브라우저에 공개됩니다. 비밀값을 이 이름으로 두면 안 됩니다.` });
    }
  }

  if (isProd && env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    problems.push({ fatal: true, message: "NODE_TLS_REJECT_UNAUTHORIZED=0 은 TLS 검증을 끕니다. 운영 환경에서 쓰면 안 됩니다." });
  }

  return problems;
}

/** DB 연결과 마이그레이션 적용 여부를 확인한다. 실패해도 예외를 던지지 않고 결과만 돌려준다. */
export async function checkDatabase(): Promise<{ ok: boolean; message: string }> {
  try {
    const { getPool } = await import("./db.ts");
    const r = await getPool().query(
      "select to_regclass('public.notes') is not null as has_schema, (select count(*) from schema_migrations)::int as applied",
    );
    const row = r.rows[0];
    if (!row?.has_schema) return { ok: false, message: "DB 에 테이블이 없습니다. `npm run db:migrate` 를 먼저 실행하세요." };
    return { ok: true, message: `DB 연결 확인 (마이그레이션 ${row.applied}개 적용됨)` };
  } catch (err) {
    const name = (err as Error)?.name ?? "Error";
    // schema_migrations 자체가 없으면 42P01 (undefined_table)
    const code = (err as { code?: string })?.code;
    if (code === "42P01") return { ok: false, message: "DB 에 테이블이 없습니다. `npm run db:migrate` 를 먼저 실행하세요." };
    return { ok: false, message: `DB 에 연결할 수 없습니다 (${name}). DATABASE_URL 과 DB 상태를 확인하세요.` };
  }
}
