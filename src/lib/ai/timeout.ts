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

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
