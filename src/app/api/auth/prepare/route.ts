import { NextResponse } from "next/server";
import { prepareLoginCode } from "../../../../lib/auth.ts";
import { badRequest } from "../../../../lib/errors.ts";
import { clientIp, rateLimit, readJson, route } from "../../../../lib/http.ts";

/** 계정·팀 생성 전에 코드를 보관한다. 여기서는 DB에 아무것도 쓰지 않는다. */
export const POST = route(async (req) => {
  rateLimit(`auth-prepare:${clientIp(req)}`, 60, 60 * 60 * 1000);
  const body = await readJson(req);
  const purpose = body.purpose ?? "signup";
  if (purpose !== "signup" && purpose !== "rotate") throw badRequest("코드 발급 목적이 올바르지 않습니다.");
  return NextResponse.json(prepareLoginCode(purpose), { headers: { "Cache-Control": "no-store" } });
});
