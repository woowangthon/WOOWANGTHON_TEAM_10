import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString, max: 5 });
  }
  return pool;
}

export type Db = pg.Pool | pg.PoolClient;

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function audit(db: Db, actor: string | null, action: string, target: string | null, detail?: object) {
  await db.query("insert into audit_log (actor, action, target, detail) values ($1, $2, $3, $4)", [
    actor,
    action,
    target,
    detail ? JSON.stringify(detail) : null,
  ]);
}
