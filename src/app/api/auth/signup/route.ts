import { NextResponse } from "next/server";
import { issueSession, SESSION_COOKIE, sessionCookieOptions, signUp } from "../../../../lib/auth.ts";
import { rateLimit, readJson, route } from "../../../../lib/http.ts";

export const POST = route(async (req) => {
  rateLimit(`signup:${req.headers.get("x-forwarded-for") ?? "local"}`);
  const body = await readJson(req);
  const { userId } = await signUp({ email: body.email, password: body.password, displayName: body.displayName });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueSession(userId), sessionCookieOptions);
  return res;
});
