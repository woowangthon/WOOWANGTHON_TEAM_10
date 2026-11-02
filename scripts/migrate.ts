// 사용법: DATABASE_URL=... npm run db:migrate
// db/migrations/*.sql 을 파일명 순서대로 한 번씩만 적용한다.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const dir = path.join(import.meta.dirname, "..", "db", "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`마이그레이션 실패: ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 환경변수가 필요합니다.");
    process.exit(1);
  }
  migrate(url).then(
    (applied) => console.log(applied.length ? `적용: ${applied.join(", ")}` : "적용할 마이그레이션 없음"),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
