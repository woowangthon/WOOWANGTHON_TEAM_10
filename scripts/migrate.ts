// 사용법: DATABASE_URL=... npm run db:migrate
// db/migrations/*.sql 을 파일명 순서대로 한 번씩만 적용한다.
// 운영 배포(Vercel Production)에서는 빌드 단계가 이 함수를 자동으로 부른다 (scripts/predeploy.ts).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// 두 곳에서 동시에 돌려도(예: 운영 배포 빌드와 사람) 같은 파일을 두 번 적용하지 않게 하는 잠금 번호. 임의의 고정 값이다.
const MIGRATION_LOCK = 1835625079;

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];

  /** 트랜잭션 안에서 잠금을 잡고 fn 을 실행한다. 잠금은 커밋·롤백 때 풀리므로 연결 풀(PgBouncer)을 거쳐도 동작한다. */
  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      const result = await fn();
      await client.query("commit");
      return result;
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {
        // 연결이 끊긴 경우: 원래 오류를 그대로 전달한다
      }
      throw err;
    }
  };

  try {
    await locked(() =>
      client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"),
    );
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
    const files = (await readdir(dir))
      .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        const ran = await locked(async () => {
          // 잠금을 기다리는 사이 다른 쪽이 먼저 적용했을 수 있으므로 잠금 안에서 다시 확인한다
          const again = await client.query("select 1 from schema_migrations where name = $1", [file]);
          if (again.rowCount) return false;
          await client.query(sql);
          await client.query("insert into schema_migrations (name) values ($1)", [file]);
          return true;
        });
        if (ran) applied.push(file);
      } catch (err) {
        throw new Error(`마이그레이션 실패: ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

// 직접 실행했을 때만 동작 (한글 경로 등에서도 안전하게 비교)
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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
