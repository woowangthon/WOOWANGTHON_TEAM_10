// 운영 배포의 빌드 단계에서 DB 마이그레이션을 적용한다. package.json 의 build 가 `next build` 앞에서 부른다.
//
// 왜 필요한가 (2026-11-10 장애): 새 마이그레이션이 든 코드를 병합했는데 운영 DB 에는 적용되지 않아,
// 배포본이 없는 열을 조회하면서 가입·로그인이 모두 500 으로 실패했다. 사람이 "배포 전에 직접 적용"하는 순서는
// 빠뜨리거나 다른 DB 에 적용해도 알 수 없다. 그래서 운영 배포가 **자기가 실제로 쓸 DB**에 직접 적용하게 한다.
//
// 동작
//  - Vercel 운영 배포(VERCEL_ENV=production)일 때만 적용한다. 로컬 빌드·CI·미리보기 배포에서는 아무것도 하지 않는다.
//    미리보기 배포는 아직 병합되지 않은 브랜치이므로 운영 DB 를 바꾸면 안 된다.
//  - 적용에 실패하면 빌드를 실패시킨다. 스키마가 맞지 않는 코드가 운영에 나가지 않고, 이전 배포본이 계속 서비스한다.
//  - 새 스키마가 적용된 뒤 새 코드가 올라오기까지 잠깐은 이전 코드가 새 스키마로 돈다.
//    그래서 마이그레이션은 이전 코드가 계속 동작하도록(열·표 추가 위주로) 쓴다.
//  - SKIP_DEPLOY_MIGRATIONS=1 이면 건너뛴다(직접 적용할 때). 이 경우 /api/health 가 빠진 마이그레이션을 알려준다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.ts";

type Env = Record<string, string | undefined>;

/** 지금 빌드가 DB 마이그레이션을 적용해야 하는지와 그 이유. */
export function deployMigrationPlan(env: Env): { run: boolean; reason: string } {
  if (env.VERCEL_ENV !== "production") {
    return { run: false, reason: env.VERCEL_ENV ? `운영 배포가 아님 (VERCEL_ENV=${env.VERCEL_ENV})` : "Vercel 운영 배포가 아님 (로컬·CI 빌드)" };
  }
  if (env.SKIP_DEPLOY_MIGRATIONS === "1") {
    return { run: false, reason: "SKIP_DEPLOY_MIGRATIONS=1 (운영 DB 에 직접 `npm run db:migrate` 를 실행해야 함)" };
  }
  return { run: true, reason: "Vercel 운영 배포" };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const TAG = "[배포 전 마이그레이션]";
  const plan = deployMigrationPlan(process.env);
  if (!plan.run) {
    console.log(`${TAG} 건너뜀: ${plan.reason}`);
  } else {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error(`${TAG} DATABASE_URL 이 빌드 환경에 없습니다. Vercel 프로젝트의 Environment Variables(Production)를 확인하세요.`);
      process.exit(1);
    }
    try {
      const applied = await migrate(url);
      console.log(`${TAG} ${applied.length ? `적용: ${applied.join(", ")}` : "적용할 마이그레이션 없음 (이미 최신)"}`);
    } catch (err) {
      // 접속 주소는 출력하지 않는다. migrate 의 메시지에는 파일명과 DB 오류 문구만 들어 있다.
      console.error(`${TAG} 실패: ${(err as Error).message}`);
      console.error(`${TAG} 빌드를 중단합니다. 이전 배포본이 계속 서비스됩니다.`);
      process.exit(1);
    }
  }
}
