import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({
      connectionString,
      max: 5,
      // 멈춘 질의가 연결을 영원히 붙들지 않게 한다 (밀리초)
      statement_timeout: 15_000,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // 놀고 있는 연결이 끊겨도 프로세스가 죽지 않게 한다
    pool.on("error", (err) => console.error("pg pool error", err.name));
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
    try {
      await client.query("rollback");
    } catch {
      // 연결 자체가 끊긴 경우: 원래 오류를 그대로 전달한다
    }
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
