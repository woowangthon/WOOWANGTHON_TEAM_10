// 이 코드가 요구하는 DB 마이그레이션 목록. db/migrations/ 의 파일명과 같아야 한다.
//
// 왜 폴더를 직접 읽지 않나: 운영(Vercel) 서버 함수에는 db/migrations 폴더가 함께 올라가지 않는다.
// 그래서 실행 중에는 이 목록과 DB 의 적용 기록(schema_migrations)을 비교한다.
// 마이그레이션 파일을 추가하면 여기에도 추가한다. 빠뜨리면 tests/deploy-safety.test.ts 가 실패한다.
export const REQUIRED_MIGRATIONS: readonly string[] = [
  "001_init.sql",
  "002_advice_pipeline.sql",
  "003_account_deletion.sql",
  "004_chat_and_memos.sql",
  "005_meeting_notes.sql",
  "006_ai_only_visibility.sql",
  "007_chat_memory.sql",
  "008_email_free_accounts.sql",
  "009_consumed_auth_tickets.sql",
];

/** 요구하는 마이그레이션 중 DB 에 아직 적용되지 않은 것 (파일명 순서). */
export function pendingMigrations(applied: Iterable<string>, required: readonly string[] = REQUIRED_MIGRATIONS): string[] {
  const done = new Set(applied);
  return required.filter((name) => !done.has(name));
}
