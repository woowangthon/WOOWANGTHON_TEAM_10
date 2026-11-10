import { NextResponse } from "next/server";
import { rotateLoginCode } from "../../../../lib/auth.ts";
import { badRequest } from "../../../../lib/errors.ts";
import { currentUserId, rateLimit, readJson, route } from "../../../../lib/http.ts";

export const POST = route(async (req) => {
  const userId = await currentUserId();
  rateLimit(`account-code:${userId}`, 5);
  const body = await readJson(req);
  if (typeof body.registrationTicket !== "string") throw badRequest("바꾸기 전에 새 개인 로그인 코드를 받아 보관해 주세요.");
  await rotateLoginCode(userId, body.loginCode, body.registrationTicket);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
});
