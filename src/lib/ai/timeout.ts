import { AsyncLocalStorage } from "node:async_hooks";

type Env = Record<string, string | undefined>;

export class AiTimeout extends Error {
  constructor() {
    super("AI call timed out");
    this.name = "AiTimeout";
  }
}

/** 모델 호출 시간 제한 (AI_TIMEOUT_MS, 기본 30초, 1~120초 범위). */
export function aiTimeoutMs(env: Env = process.env): number {
  const n = Number(env.AI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 && n <= 120_000 ? n : 30_000;
}

/**
 * fn 이 ms 안에 끝나지 않으면 AiTimeout 으로 실패한다.
 * fn 에는 취소 신호를 넘긴다. 시간이 다 되면 그 신호를 취소해, 진행 중인 모델 요청과 남은 재시도가 실제로 멈추게 한다.
 * (이전에는 호출자만 실패하고 요청은 뒤에서 계속 재시도했다: 결과는 버려지는데 비용과 시간은 나갔다.)
 */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 먼저 시간 초과로 끝낸 뒤 요청을 취소한다. 순서가 반대면 취소된 요청의 오류가 먼저 도착해
          // 시간 초과가 일반 모델 오류(ai_error)로 기록된다.
          reject(new AiTimeout());
          controller.abort();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 요청 하나의 모델 호출 시간 ----------
// 요청 하나가 모델을 여러 번 부르면(대화: 요약 + 답변 + 다시 쓰기, 조언: 판정 + 조언) 호출마다의 제한을 더한 시간이
// 서버 함수의 제한(route.ts maxDuration 60초)을 넘는다. 함수가 먼저 끊기면 실패를 기록하지 못해 그 질문이 5분 동안
// "작성 중"으로 남는다. 그래서 요청 전체에 시간을 정해 두고, 각 호출은 남은 시간까지만 기다린다.
const budget = new AsyncLocalStorage<{ deadline: number }>();

/** 요청 하나가 모델 호출에 쓸 수 있는 전체 시간 (AI_REQUEST_BUDGET_MS, 기본 50초: 함수 제한 60초에서 DB 처리 여유를 뺀 값). */
export function aiRequestBudgetMs(env: Env = process.env): number {
  const n = Number(env.AI_REQUEST_BUDGET_MS);
  return Number.isFinite(n) && n >= 1000 && n <= 280_000 ? n : 50_000;
}

/** fn 안의 모델 호출(callAi)에 요청 전체 시간을 건다. 이미 걸려 있으면 바깥 것을 그대로 쓴다. */
export function withAiBudget<T>(fn: () => Promise<T>, ms: number = aiRequestBudgetMs()): Promise<T> {
  if (budget.getStore()) return fn();
  return budget.run({ deadline: Date.now() + ms }, fn);
}

/** 이 요청이 모델 호출에 더 쓸 수 있는 시간. 요청 전체 시간이 걸려 있지 않으면 Infinity. */
export function aiBudgetRemainingMs(): number {
  const b = budget.getStore();
  return b ? b.deadline - Date.now() : Infinity;
}
