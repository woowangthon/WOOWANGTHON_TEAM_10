import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../lib/auth.ts";
import { route } from "../../../../lib/http.ts";

export const POST = route(async () => {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
