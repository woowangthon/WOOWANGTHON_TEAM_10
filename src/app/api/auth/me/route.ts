import { NextResponse } from "next/server";
import { deleteAccount } from "../../../../lib/account.ts";
import { getUser, SESSION_COOKIE } from "../../../../lib/auth.ts";
import { unauthorized } from "../../../../lib/errors.ts";
import { currentUserId, rateLimit, readJson, route } from "../../../../lib/http.ts";

export const GET = route(async () => {
  const user = await getUser(await currentUserId());
  if (!user) throw unauthorized();
  return { id: user.id, email: user.email, displayName: user.display_name };
});

/** 회원 탈퇴. 본문: { password } */
export const DELETE = route(async (req) => {
  const userId = await currentUserId();
  rateLimit(`account-delete:${userId}`, 5);
  const body = await readJson(req);
  const result = await deleteAccount(userId, { password: body.password });
  const res = NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
