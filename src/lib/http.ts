// 모든 API 경로가 공통으로 쓰는 처리:
//  - 로그인 세션 확인
//  - 상태를 바꾸는 요청(POST/PATCH/DELETE)은 같은 사이트에서 온 것만 허용 (CSRF 방어)
//  - 예상한 오류(AppError)만 사용자에게 보여주고, 나머지는 일반 메시지로 숨김
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "./auth.ts";
import { getPool } from "./db.ts";
import { AppError, badRequest, forbidden, unauthorized } from "./errors.ts";

export async function currentUserId(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = readSession(token);
  if (!userId) throw unauthorized();
  // 서명이 맞아도 탈퇴한 계정의 쿠키는 받지 않는다 (쿠키는 기기에 7일간 남을 수 있다)
  const r = await getPool().query("select 1 from users where id = $1", [userId]);
  if (!r.rowCount) throw unauthorized();
  return userId;
}

function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) throw forbidden();
  if (!req.headers.get("content-type")?.startsWith("application/json") && req.method !== "DELETE") {
    throw badRequest("JSON 요청만 받습니다.");
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > 20_000) throw badRequest("요청이 너무 큽니다.");
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw badRequest("JSON 형식이 올바르지 않습니다.");
  }
}

/**
 * 운영 로그에 남길 오류 요약. 메시지·SQL·본문은 넣지 않고, 오류 종류와 다섯 글자 오류 코드만 남긴다.
 * PostgreSQL 오류에는 SQLSTATE(예: 42703 없는 열, 42P01 없는 표)가 code 로 붙는다. 이 코드가 없으면
 * "코드가 기대하는 열·표가 DB 에 없는" 장애가 로그에 `error` 한 단어로만 남아 원인을 알 수 없다.
 */
export function errorSummary(err: unknown): string {
  const name = typeof (err as Error)?.name === "string" && (err as Error).name ? (err as Error).name : "Error";
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return name;
  const hint = code === "42703" || code === "42P01" ? " (DB 에 없는 열·표를 썼음: 마이그레이션 적용 여부를 확인)" : "";
  return `${name} ${code}${hint}`;
}

type Handler<P> = (req: Request, params: P) => Promise<unknown>;

export function route<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      assertSameOrigin(req);
      const result = await handler(req, await ctx.params);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (err instanceof AppError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      }
      // 본문·SQL 은 로그에 남기지 않고 종류와 DB 오류 코드만 남긴다 (개발 중에는 메시지도 함께)
      const detail = process.env.NODE_ENV === "production" ? errorSummary(err) : String((err as Error)?.message ?? err);
      console.error("unhandled", req.method, new URL(req.url).pathname, detail);
      return NextResponse.json({ error: "internal", message: "일시적인 오류가 발생했습니다." }, { status: 500 });
    }
  };
}

/** 프록시(Vercel 등) 뒤에서 실제 접속 IP 를 구한다. 헤더는 위조될 수 있으므로 IP 제한은 보조 수단으로만 쓴다. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : "local";
}

// 단순한 요청 횟수 제한 (서버 프로세스 메모리 기준). 서버가 재시작되면 초기화된다.
// 만료된 항목은 주기적으로 지워 메모리가 계속 늘지 않게 한다.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED_KEYS = 10_000;
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000 && attempts.size < MAX_TRACKED_KEYS) return;
  lastSweep = now;
  for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
  // 비정상적으로 많은 키가 살아 있으면(대량 요청) 오래된 것부터 버린다
  if (attempts.size >= MAX_TRACKED_KEYS) {
    for (const k of [...attempts.keys()].slice(0, attempts.size - MAX_TRACKED_KEYS / 2)) attempts.delete(k);
  }
}

export function rateLimit(key: string, max = 10, windowMs = 15 * 60 * 1000, now = Date.now()) {
  sweep(now);
  const a = attempts.get(key);
  if (!a || a.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  a.count += 1;
  if (a.count > max) throw new AppError(429, "rate_limited", "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
}

/** 테스트용 */
export function resetRateLimits() {
  attempts.clear();
  lastSweep = 0;
}

export function trackedRateLimitKeys() {
  return attempts.size;
}
