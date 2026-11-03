// Next.js 가 서버를 시작할 때 한 번 호출한다 (docs/01-app/02-guides/instrumentation.md).
// 치명적인 설정 오류는 여기서 멈추고, DB 연결 문제는 로그로 알린다.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnvironment, checkDatabase } = await import("./lib/startup.ts");

  const problems = checkEnvironment(process.env);
  for (const p of problems) console[p.fatal ? "error" : "warn"](`[설정 ${p.fatal ? "오류" : "경고"}] ${p.message}`);
  if (problems.some((p) => p.fatal)) {
    throw new Error("설정 오류로 서버를 시작할 수 없습니다. 위 메시지를 확인하세요. (.env.example 참고)");
  }

  const db = await checkDatabase();
  console[db.ok ? "log" : "error"](`[시작 점검] ${db.message}`);
}
