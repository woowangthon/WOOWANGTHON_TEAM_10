// 모든 팀 자료 접근은 여기서 시작한다. 클라이언트가 보낸 team_id 를 그대로 믿지 않는다.
import type { Db } from "./db.ts";
import { notFound } from "./errors.ts";

export type Membership = { teamId: string; userId: string; role: "member" | "lead" };

export async function requireMembership(db: Db, userId: string, teamId: string): Promise<Membership> {
  const r = await db.query(
    "select role from memberships where team_id = $1 and user_id = $2 and status = 'active'",
    [teamId, userId],
  );
  // 팀이 없음 / 가입 안 함 / 탈퇴를 구분하지 않고 404 → 다른 팀의 존재 여부를 알려주지 않음
  if (!r.rowCount) throw notFound();
  return { teamId, userId, role: r.rows[0].role };
}
