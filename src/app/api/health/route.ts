// 배포 상태 점검용. 로그인 없이 접근할 수 있으므로 "살아 있는지"와 DB 연결 여부만 알려준다.
import { NextResponse } from "next/server";
import { checkDatabase } from "../../../lib/startup.ts";

export async function GET() {
  const db = await checkDatabase();
  return NextResponse.json(
    { ok: db.ok, db: db.ok ? "ok" : "error" },
    { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
