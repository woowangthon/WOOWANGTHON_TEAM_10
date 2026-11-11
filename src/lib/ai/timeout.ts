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
          controller.abort();
          reject(new AiTimeout());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
