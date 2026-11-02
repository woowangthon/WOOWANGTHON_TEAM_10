import { NextResponse } from "next/server";
import { issueSession, logIn, SESSION_COOKIE, sessionCookieOptions } from "../../../../lib/auth.ts";
import { rateLimit, readJson, route } from "../../../../lib/http.ts";

export const POST = route(async (req) => {
  rateLimit(`login:${req.headers.get("x-forwarded-for") ?? "local"}`);
  const body = await readJson(req);
  // IP 헤더는 위조될 수 있으므로 이메일 기준으로도 제한한다
  rateLimit(`login-email:${String(body.email ?? "").toLowerCase().slice(0, 254)}`);
  const { userId } = await logIn({ email: body.email, password: body.password });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueSession(userId), sessionCookieOptions);
  return res;
});
