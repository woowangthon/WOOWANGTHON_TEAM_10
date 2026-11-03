# mijuk00 — 팀 기억 기반 공동 AI 조언자

팀원이 짧게 남긴 미완성 생각을 **작성자 확인 후** 팀 기억에 저장하고, 다른 팀원이 작업할 때 관련 생각을 찾아 **근거 있는 조언**으로 연결하는 웹 서비스.

| 문서 | 내용 |
| --- | --- |
| [`docs/구현_구체화.md`](docs/구현_구체화.md) | 설계: 무엇을, 왜, 어떤 구조로 만드는가 |
| [`docs/보안_점검.md`](docs/보안_점검.md) | 보안 점검 기록과 지켜야 할 규칙 |
| [`docs/평가_보고서.md`](docs/평가_보고서.md) | 지금까지 만든 것의 평가: 된 것·안 된 것·한계 |

## 현재 상태 (2026-11-03)

**AI 없이 전체 흐름이 끝까지 동작한다.** 실제 AI(Claude)는 아직 연결하지 않았다 (`AI_PROVIDER=none`).

- 가입/로그인(비밀번호는 scrypt 해시, 서명된 세션 쿠키, 시도 횟수 제한)
- 팀 만들기 · 초대 코드로 가입 · 코드 재발급 · 나가기(유일한 팀장이 나가면 자동 승계)
- 메모: 초안 → 작성자 확인(정확한 버전·해시 고정) → 팀 공유 → 수정/철회/삭제
- 작업 만들기·수정, **작업 조언**: 권한 → 후보 검색 → (AI) 판정·생성 → 서버 검증 → 확정 직전 재확인
- 조언 구획: 팀 메모에 있는 내용 / 연결 이유(AI 해석) / AI 확장 / 반론·확인 / 근거 없는 일반 제안
- 적용·보류·제외 기록, 같은 제안이 다시 나오면 접어서 표시
- 근거 메모가 철회·수정되면 조언 무효화·숨김, 삭제되면 저장된 조언 본문까지 제거
- 서버 시작 시 설정 검사, `/api/health` 상태 점검

### AI 연결 상태 (`AI_PROVIDER`)

| 값 | 동작 |
| --- | --- |
| `none` (기본) | AI를 부르지 않음. 메모는 원문 그대로 등록, 조언은 **키워드가 겹치는 팀 메모만** "키워드 일치 · AI 미사용" 표시로 보여줌 |
| `fake` | 개발용 가짜 응답. 모든 출력에 【개발용 가짜 응답】 표시. **운영 환경(`NODE_ENV=production`, Vercel)에서는 서버가 시작을 거부** |
| `claude` | 다음 단계 (API 키 필요). `src/lib/ai/types.ts` 의 `AiProvider` 인터페이스를 구현하면 된다 |

모델 출력은 `src/lib/ai/validate-output.ts` 에서 검증한다. 건네지 않은 근거 번호, 원문에 없는 인용, 구획 규칙 위반은 버린다.

## 로컬 실행

필요: Node.js 22.6 이상, PostgreSQL 14 이상 (`pg_trgm` 확장 — 기본 포함)

```bash
npm ci
```

```bash
cp .env.example .env.local
```

`.env.local` 에 `DATABASE_URL` 과 `SESSION_SECRET`(32자 이상 무작위 문자열)을 채운다. 이 파일은 커밋되지 않는다.

```bash
DATABASE_URL=postgres://사용자:비밀번호@localhost/mijuk npm run db:migrate
```

```bash
npm run dev
```

브라우저에서 http://localhost:3000 을 연다. 잘못된 설정이 있으면 서버가 시작하지 않고 이유를 알려준다.

## 테스트

```bash
npm run check
```

테스트는 `DATABASE_URL` 이 가리키는 DB 의 **모든 표를 비운다**. 그래서 DB 이름에 `test` 가 들어 있지 않으면 실행을 거부한다. 기본값은 `postgres://mijuk:devpass@localhost/mijuk_test` 이다.

```bash
DATABASE_URL=postgres://mijuk:devpass@localhost/mijuk_test npm test
```

GitHub 에 푸시하면 `.github/workflows/ci.yml` 이 타입 검사·테스트·빌드를 자동으로 돌린다.

## 배포 (외부 접속 URL 만들기)

1. **DB**: [Neon](https://neon.tech) 또는 [Supabase](https://supabase.com) 에서 무료 PostgreSQL 을 만들고 접속 주소(`postgres://...`)를 복사한다.
2. 로컬에서 그 주소로 표를 만든다: `DATABASE_URL=<주소> npm run db:migrate`
3. **웹**: [Vercel](https://vercel.com) 에서 이 GitHub 저장소를 가져온다(Import). Framework 는 Next.js 로 자동 인식된다.
4. Vercel 프로젝트 Settings → Environment Variables 에 다음을 넣는다.
   - `DATABASE_URL` = 1번 주소
   - `SESSION_SECRET` = `openssl rand -base64 36` 으로 만든 값
   - `AI_PROVIDER` = `none` (AI 를 연결하기 전까지)
5. Deploy 한 뒤 `https://<프로젝트>.vercel.app/api/health` 가 `{"ok":true,"db":"ok"}` 를 돌려주는지 확인한다.
6. **팀 외부 사람**(심사위원 등)이 접속·가입할 수 있는지 다른 기기·네트워크에서 확인한다.

키는 저장소·채팅·문서에 절대 넣지 않는다. 자세한 규칙은 `docs/보안_점검.md` 를 본다.

## 폴더 구조

```
db/migrations/     DB 표 정의 (번호 순서대로 한 번씩 적용)
scripts/migrate.ts 마이그레이션 실행기
src/app/           화면과 API 경로 (Next.js App Router)
src/lib/           서버 로직: 인증, 팀, 메모, 검색, 조언, AI 연결 지점(ai/)
src/instrumentation.ts  서버 시작 시 설정·DB 점검
tests/             자동 테스트 (실제 PostgreSQL 사용)
docs/              설계·보안·평가 문서
```
