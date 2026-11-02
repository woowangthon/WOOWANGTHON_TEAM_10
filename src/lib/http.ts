// 모든 API 경로가 공통으로 쓰는 처리:
//  - 로그인 세션 확인
//  - 상태를 바꾸는 요청(POST/PATCH/DELETE)은 같은 사이트에서 온 것만 허용 (CSRF 방어)
//  - 예상한 오류(AppError)만 사용자에게 보여주고, 나머지는 일반 메시지로 숨김
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "./auth.ts";
import { AppError, badRequest, forbidden, unauthorized } from "./errors.ts";

export async function currentUserId(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = readSession(token);
  if (!userId) throw unauthorized();
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
      // 본문·SQL 은 로그에 남기지 않고 종류만 남긴다
      console.error("unhandled", req.method, new URL(req.url).pathname, (err as Error)?.name);
      return NextResponse.json({ error: "internal", message: "일시적인 오류가 발생했습니다." }, { status: 500 });
    }
  };
}

// 아주 단순한 로그인 시도 제한 (서버 프로세스 메모리 기준, 15분에 10회)
const attempts = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  a.count += 1;
  if (a.count > max) throw new AppError(429, "rate_limited", "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
}
