# mijuk00 — 팀 기억 기반 공동 AI 조언자

팀원이 짧게 남긴 미완성 생각을 **작성자 확인 후** 팀 기억에 저장하고, 다른 팀원이 작업할 때 관련 생각을 찾아 **근거 있는 조언**으로 연결하는 웹 서비스.

| 문서 | 내용 |
| --- | --- |
| [`docs/구현_구체화.md`](docs/구현_구체화.md) | 설계: 무엇을, 왜, 어떤 구조로 만드는가 |
| [`docs/보안_점검.md`](docs/보안_점검.md) | 보안 점검 기록과 지켜야 할 규칙 |
| [`docs/평가_보고서.md`](docs/평가_보고서.md) | 지금까지 만든 것의 평가: 된 것·안 된 것·한계 |

## 현재 상태 (2026-11-03)

**전체 흐름이 끝까지 동작하고, OpenAI(GPT-6.1 Terra)를 연결해 실제 모델로 평가를 돌렸다** (`AI_PROVIDER=openai`). AI 없이도 동작한다 (`AI_PROVIDER=none`).

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
| `openai` | OpenAI Responses API. 기본 모델 `gpt-6.1-terra`, 추론 강도 `OPENAI_REASONING_EFFORT`(기본 `none`). 키는 `OPENAI_API_KEY` |

모델 출력은 JSON 스키마로 고정하고(`src/lib/ai/prompts.ts`), 그래도 `src/lib/ai/validate-output.ts` 에서 다시 검증한다. 건네지 않은 근거 번호, 원문에 없는 인용, 구획 규칙 위반은 버린다. 대화는 OpenAI 쪽에 저장하지 않는다(`store: false`). 다른 모델을 붙이려면 `src/lib/ai/types.ts` 의 `AiProvider` 인터페이스를 구현한다.

> **프록시 뒤에서 개발할 때**: Node.js 의 `fetch` 는 `HTTPS_PROXY` 환경변수를 기본으로 따르지 않는다. Claude 클라우드 세션처럼 프록시를 거치는 환경에서는 `NODE_USE_ENV_PROXY=1` 을 붙여 실행한다 (`NODE_USE_ENV_PROXY=1 npm run dev`). 본인 PC·Vercel 에서는 필요 없다.

### 평가 (실제 모델로 A/B/C 비교)

```bash
DATABASE_URL=postgres://mijuk:devpass@localhost/mijuk_eval AI_PROVIDER=openai npm run eval
```

가상 메모 40개·질문 10개로 세 조건을 비교하고 `eval/results/<실행ID>/report.md` 에 지표와 사람 점검표를 남긴다. 자세한 설명은 [`eval/README.md`](eval/README.md).

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
   - `AI_PROVIDER` = `openai`, `OPENAI_API_KEY` = OpenAI 프로젝트 키 (월 예산 한도를 건 것), `OPENAI_REASONING_EFFORT` = `none`
     (AI 없이 운영하려면 `AI_PROVIDER` = `none`)
5. Deploy 한 뒤 `https://<프로젝트>.vercel.app/api/health` 가 `{"ok":true,"db":"ok"}` 를 돌려주는지 확인한다.
6. **팀 외부 사람**(심사위원 등)이 접속·가입할 수 있는지 다른 기기·네트워크에서 확인한다.

키는 저장소·채팅·문서에 절대 넣지 않는다. 자세한 규칙은 `docs/보안_점검.md` 를 본다.

### 배포 점검 (제출 전마다)

배포된 주소에서 가입 → 팀 → 메모 → AI 정리 → 공유 → 조언 → 반응 → 철회 → 숨김 → 타 팀 차단까지 실제 요청으로 한 바퀴 돌려 통과/실패를 보여준다. 브라우저나 DB 접근 없이 Node.js 만 있으면 된다.

```bash
npm run smoke -- --url=https://<프로젝트>.vercel.app
```

시험용 계정(`smoke+…@example.invalid`)을 만들고 끝나면 팀을 떠난다. 실패하면 메시지와 Vercel 의 Logs 를 본다. 심사 전날에도 한 번 돌려 DB 를 깨워 둔다.

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
