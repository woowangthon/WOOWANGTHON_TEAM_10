// 배포 상태 점검용. 로그인 없이 접근할 수 있으므로 최소한만 알려준다:
//  - DB 에 연결되는지
//  - 이 코드가 요구하는 마이그레이션이 그 DB 에 모두 적용됐는지 (빠졌으면 503, 빠진 개수만 공개)
//  - 지금 서비스 중인 배포본의 커밋 (제출한 커밋과 배포본이 같은지, 새 배포가 올라왔는지 확인하는 데 쓴다)
// 빠진 마이그레이션의 이름은 응답에 넣지 않고 서버 로그에만 남긴다.
import { NextResponse } from "next/server";
import { checkDatabase } from "../../../lib/startup.ts";

/** Vercel 이 넣어 주는 배포 커밋. 형식이 맞을 때만 앞 7자를 돌려준다. 로컬·다른 호스팅에서는 null. */
function deployedCommit(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : null;
}

export async function GET() {
  const db = await checkDatabase();
  if (!db.ok) console.error(`[상태 점검] ${db.message}`);
  return NextResponse.json(
    {
      ok: db.ok,
      db: db.state === "ok" ? "ok" : db.state === "migrations_pending" ? "migrations_pending" : "error",
      pendingMigrations: db.pending.length,
      commit: deployedCommit(),
    },
    { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
