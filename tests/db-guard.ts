// 테스트는 DB 의 모든 표를 비운다. 실수로 운영 DB 를 가리키는 일을 막는다.
export function assertTestDatabase(url: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (!url) throw new Error("DATABASE_URL 이 없습니다. 테스트 전용 DB 주소를 지정하세요.");
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL 형식이 올바르지 않습니다.");
  }
  if (!/test/i.test(name) && env.ALLOW_TEST_DB_TRUNCATE !== "1") {
    throw new Error(
      `테스트는 DB "${name}" 의 모든 표를 비웁니다. 이름에 "test" 가 들어간 전용 DB 를 쓰거나, ` +
        "정말 괜찮다면 ALLOW_TEST_DB_TRUNCATE=1 을 설정하세요.",
    );
  }
  return name;
}
