import { NextResponse } from "next/server";
import { issueSession, logIn, SESSION_COOKIE, sessionCookieOptions } from "../../../../lib/auth.ts";
import { clientIp, rateLimit, readJson, route } from "../../../../lib/http.ts";

export const POST = route(async (req) => {
  // IP 기준은 느슨하게(같은 와이파이의 팀원들이 함께 막히지 않게), 계정 기준은 엄격하게
  rateLimit(`login-ip:${clientIp(req)}`, 60);
  const body = await readJson(req);
  rateLimit(`login-email:${String(body.email ?? "").toLowerCase().slice(0, 254)}`, 10);
  const { userId } = await logIn({ email: body.email, password: body.password });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueSession(userId), sessionCookieOptions);
  return res;
});
