import { requireMembership } from "./access.ts";
import { audit, getPool, withTx } from "./db.ts";
import { notFound } from "./errors.ts";
import { optionalText, text } from "./validate.ts";

export type TaskInput = { title: unknown; purpose?: unknown; audience?: unknown; constraints?: unknown };

export async function createTask(userId: string, teamId: string, input: TaskInput) {
  const db = getPool();
  await requireMembership(db, userId, teamId);
  const r = await db.query(
    `insert into tasks (team_id, created_by, title, purpose, audience, constraints)
     values ($1, $2, $3, $4, $5, $6) returning id, title, purpose, audience, constraints, version`,
    [
      teamId,
      userId,
      text(input.title, "작업 제목", { min: 1, max: 200 }),
      optionalText(input.purpose, "목적", 1000),
      optionalText(input.audience, "대상", 500),
      optionalText(input.constraints, "제약", 1000),
    ],
  );
  await audit(db, userId, "task.create", r.rows[0].id);
  return r.rows[0];
}

export async function listTasks(userId: string, teamId: string) {
  const db = getPool();
  await requireMembership(db, userId, teamId);
  const r = await db.query(
    "select id, title, purpose, audience, constraints, version from tasks where team_id = $1 order by created_at desc",
    [teamId],
  );
  return r.rows;
}

export async function getTask(userId: string, taskId: string) {
  const db = getPool();
  const r = await db.query("select * from tasks where id = $1", [taskId]);
  if (!r.rowCount) throw notFound();
  await requireMembership(db, userId, r.rows[0].team_id);
  return r.rows[0];
}

/** 작업 수정: 버전을 올린다. 생성 중이던 조언은 확정 단계에서 버전이 다르면 무효화된다. */
export async function updateTask(userId: string, taskId: string, input: TaskInput) {
  return withTx(async (tx) => {
    const r = await tx.query("select team_id from tasks where id = $1 for update", [taskId]);
    if (!r.rowCount) throw notFound();
    await requireMembership(tx, userId, r.rows[0].team_id);
    const u = await tx.query(
      `update tasks set title = $2, purpose = $3, audience = $4, constraints = $5, version = version + 1
       where id = $1 returning id, title, purpose, audience, constraints, version`,
      [
        taskId,
        text(input.title, "작업 제목", { min: 1, max: 200 }),
        optionalText(input.purpose, "목적", 1000),
        optionalText(input.audience, "대상", 500),
        optionalText(input.constraints, "제약", 1000),
      ],
    );
    await audit(tx, userId, "task.update", taskId);
    return u.rows[0];
  });
}
