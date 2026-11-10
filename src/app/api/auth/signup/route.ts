import { NextResponse } from "next/server";
import { issueSession, SESSION_COOKIE, sessionCookieOptions, startWithTeam } from "../../../../lib/auth.ts";
import { badRequest } from "../../../../lib/errors.ts";
import { clientIp, rateLimit, readJson, route } from "../../../../lib/http.ts";

export const POST = route(async (req) => {
  rateLimit(`signup:${clientIp(req)}`, 20, 60 * 60 * 1000);
  const body = await readJson(req);
  if ("email" in body || "password" in body) throw badRequest("새 계정은 이메일 없이 이름과 팀으로 시작합니다.");
  if (typeof body.registrationTicket !== "string") throw badRequest("시작하기 전에 개인 로그인 코드를 받아 보관해 주세요.");
  const { userId, team, authMethod } = await startWithTeam({ displayName: body.displayName, teamName: body.teamName, inviteCode: body.inviteCode, registrationTicket: body.registrationTicket });
  const res = NextResponse.json({ ok: true, team, authMethod }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, issueSession(userId), sessionCookieOptions);
  return res;
});
