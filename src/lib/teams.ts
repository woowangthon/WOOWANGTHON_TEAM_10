import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { requireMembership } from "./access.ts";
import { audit, getPool, withTx } from "./db.ts";
import { inviteNotFound, notFound } from "./errors.ts";
import { withdrawAiOnlyNotesOf } from "./notes.ts";
import { text } from "./validate.ts";

export async function createTeam(userId: string, nameInput: unknown) {
  const name = text(nameInput, "팀 이름", { min: 1, max: 80 });
  const inviteCode = randomBytes(9).toString("base64url");
  return withTx(async (tx) => {
    const t = await tx.query("insert into teams (name, invite_code) values ($1, $2) returning id, name", [name, inviteCode]);
    const team = t.rows[0];
    await tx.query("insert into memberships (team_id, user_id, role) values ($1, $2, 'lead')", [team.id, userId]);
    await audit(tx, userId, "team.create", team.id);
    return { id: team.id as string, name: team.name as string, inviteCode };
  });
}

/**
 * 초대 코드로 참여한다.
 *  - 이미 팀원이면 아무것도 바꾸지 않는다 (참여 시각이 바뀌면 팀장 승계 순서가 바뀐다).
 *  - 나갔다 돌아오는 사람은 예전 역할과 관계없이 팀원으로 시작한다 (나갈 때 넘긴 팀장 권한이 되살아나지 않게).
 *  - 팀장이 없는 팀(모두 나간 팀)이면 들어오는 사람이 팀장이 된다 (팀장 없는 팀이 생기지 않게).
 */
export async function joinTeam(userId: string, codeInput: unknown) {
  const code = text(codeInput, "초대 코드", { min: 1, max: 64 });
  return withTx(async (tx) => {
    // 동시 참여·나가기와 꼬이지 않게 팀 행을 잠근다 (leaveTeamInTx 와 같은 잠금)
    const t = await tx.query("select id, name from teams where invite_code = $1 for update", [code]);
    if (!t.rowCount) throw inviteNotFound();
    const team = t.rows[0];
    const me = await tx.query("select status from memberships where team_id = $1 and user_id = $2", [team.id, userId]);
    if (me.rows[0]?.status === "active") return { id: team.id as string, name: team.name as string };
    const lead = await tx.query("select 1 from memberships where team_id = $1 and status = 'active' and role = 'lead' limit 1", [team.id]);
    const role = lead.rowCount ? "member" : "lead";
    await tx.query(
      `insert into memberships (team_id, user_id, role) values ($1, $2, $3)
       on conflict (team_id, user_id) do update set status = 'active', joined_at = now(), role = excluded.role`,
      [team.id, userId, role],
    );
    await audit(tx, userId, "team.join", team.id, { role });
    return { id: team.id as string, name: team.name as string };
  });
}

/** 팀 나가기의 본체 (트랜잭션 안에서). 회원 탈퇴도 이것을 써서 팀장 승계 규칙을 똑같이 따른다. */
export async function leaveTeamInTx(tx: PoolClient, userId: string, teamId: string) {
  // 같은 팀의 동시 탈퇴가 꼬이지 않게 팀 행을 잠근다
  const t = await tx.query("select id from teams where id = $1 for update", [teamId]);
  if (!t.rowCount) throw notFound();
  const me = await tx.query(
    "select role from memberships where team_id = $1 and user_id = $2 and status = 'active'",
    [teamId, userId],
  );
  if (!me.rowCount) throw notFound();
  await tx.query("update memberships set status = 'left' where team_id = $1 and user_id = $2", [teamId, userId]);
  // 나가는 사람의 'AI만 참고' 메모는 철회한다: 작성자가 없으면 아무도 볼 수 없는 채로 AI 만 계속 참고하게 된다
  const withdrawnAiOnly = await withdrawAiOnlyNotesOf(tx, userId, teamId);

  let promoted: { userId: string; displayName: string } | null = null;
  if (me.rows[0].role === "lead") {
    const leads = await tx.query(
      "select 1 from memberships where team_id = $1 and status = 'active' and role = 'lead' limit 1",
      [teamId],
    );
    if (!leads.rowCount) {
      const next = await tx.query(
        `update memberships m set role = 'lead'
         from (select user_id from memberships where team_id = $1 and status = 'active'
               order by joined_at asc, user_id asc limit 1) pick
         where m.team_id = $1 and m.user_id = pick.user_id
         returning m.user_id, (select display_name from users where id = m.user_id) as display_name`,
        [teamId],
      );
      if (next.rowCount) promoted = { userId: next.rows[0].user_id, displayName: next.rows[0].display_name };
    }
  }
  return { promoted, withdrawnAiOnly };
}

/**
 * 팀 나가기. 유일한 팀장이 나가면 가장 오래된 팀원에게 팀장을 넘긴다 (팀이 팀장 없이 남지 않게).
 * 나간 뒤에는 팀 자료를 볼 수 없지만, 팀에 공개한 메모는 팀에 남는다 (원안 §8.1: 사전 합의 사항).
 * 'AI만 참고'로 공유한 메모는 철회한다 (notes.ts withdrawAiOnlyNotesOf).
 */
export async function leaveTeam(userId: string, teamId: string) {
  return withTx(async (tx) => {
    const { promoted, withdrawnAiOnly } = await leaveTeamInTx(tx, userId, teamId);
    await audit(tx, userId, "team.leave", teamId, { promoted: promoted?.userId ?? null, withdrawnAiOnly });
    return { left: true, promoted: promoted ? { displayName: promoted.displayName } : null, withdrawnAiOnly };
  });
}

export async function listMyTeams(userId: string) {
  const r = await getPool().query(
    `select t.id, t.name, m.role,
            (select count(*) from memberships x where x.team_id = t.id and x.status = 'active')::int as member_count
     from teams t join memberships m on m.team_id = t.id
     where m.user_id = $1 and m.status = 'active' order by t.created_at`,
    [userId],
  );
  return r.rows as { id: string; name: string; role: string; member_count: number }[];
}

/** 팀 이름·내 역할·팀원 목록 (이메일은 포함하지 않는다). */
export async function getTeam(userId: string, teamId: string) {
  const db = getPool();
  const me = await requireMembership(db, userId, teamId);
  const t = await db.query("select name from teams where id = $1", [teamId]);
  if (!t.rowCount) throw notFound();
  const members = await db.query(
    `select u.id, u.display_name, m.role from memberships m join users u on u.id = m.user_id
     where m.team_id = $1 and m.status = 'active' order by m.joined_at asc, u.display_name asc`,
    [teamId],
  );
  return {
    id: teamId,
    name: t.rows[0].name as string,
    myRole: me.role,
    members: members.rows.map((m) => ({ id: m.id as string, displayName: m.display_name as string, role: m.role as string, isMe: m.id === userId })),
  };
}

// 초대 코드는 팀장에게만 보여준다
export async function getInviteCode(userId: string, teamId: string) {
  const r = await getPool().query(
    `select t.invite_code from teams t join memberships m on m.team_id = t.id
     where t.id = $1 and m.user_id = $2 and m.status = 'active' and m.role = 'lead'`,
    [teamId, userId],
  );
  if (!r.rowCount) throw notFound();
  return r.rows[0].invite_code as string;
}

/** 초대 코드 재발급 (팀장만). 코드가 새어 나갔을 때 쓴다. */
export async function rotateInviteCode(userId: string, teamId: string) {
  const code = randomBytes(9).toString("base64url");
  return withTx(async (tx) => {
    const m = await requireMembership(tx, userId, teamId);
    if (m.role !== "lead") throw notFound();
    await tx.query("update teams set invite_code = $2 where id = $1", [teamId, code]);
    await audit(tx, userId, "team.rotate_invite", teamId);
    return { inviteCode: code };
  });
}
