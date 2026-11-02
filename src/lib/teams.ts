import { randomBytes } from "node:crypto";
import { audit, getPool, withTx } from "./db.ts";
import { notFound } from "./errors.ts";
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

export async function joinTeam(userId: string, codeInput: unknown) {
  const code = text(codeInput, "초대 코드", { min: 1, max: 64 });
  return withTx(async (tx) => {
    const t = await tx.query("select id, name from teams where invite_code = $1", [code]);
    if (!t.rowCount) throw notFound();
    const team = t.rows[0];
    await tx.query(
      `insert into memberships (team_id, user_id) values ($1, $2)
       on conflict (team_id, user_id) do update set status = 'active'`,
      [team.id, userId],
    );
    await audit(tx, userId, "team.join", team.id);
    return { id: team.id as string, name: team.name as string };
  });
}

export async function leaveTeam(userId: string, teamId: string) {
  await withTx(async (tx) => {
    const r = await tx.query(
      "update memberships set status = 'left' where team_id = $1 and user_id = $2 and status = 'active'",
      [teamId, userId],
    );
    if (!r.rowCount) throw notFound();
    await audit(tx, userId, "team.leave", teamId);
  });
}

export async function listMyTeams(userId: string) {
  const r = await getPool().query(
    `select t.id, t.name, m.role from teams t join memberships m on m.team_id = t.id
     where m.user_id = $1 and m.status = 'active' order by t.created_at`,
    [userId],
  );
  return r.rows as { id: string; name: string; role: string }[];
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
