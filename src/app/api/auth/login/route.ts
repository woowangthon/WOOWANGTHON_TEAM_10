import { NextResponse } from "next/server";
import { issueSession, logIn, logInWithCode, loginCodeFingerprint, SESSION_COOKIE, sessionCookieOptions } from "../../../../lib/auth.ts";
import { clientIp, rateLimit, readJson, route } from "../../../../lib/http.ts";

export const POST = route(async (req) => {
  // IP 기준은 느슨하게(같은 와이파이의 팀원들이 함께 막히지 않게), 계정 기준은 엄격하게
  rateLimit(`login-ip:${clientIp(req)}`, 60);
  const body = await readJson(req);
  const byCode = "loginCode" in body;
  const identity = byCode ? `code:${loginCodeFingerprint(body.loginCode)}` : `email:${String(body.email ?? "").toLowerCase().slice(0, 254)}`;
  rateLimit(`login-${identity}`, 10);
  const { userId } = byCode ? await logInWithCode(body.loginCode) : await logIn({ email: body.email, password: body.password });
  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, issueSession(userId), sessionCookieOptions);
  return res;
});
