// 어떤 AI 제공자를 쓸지 고른다 (환경변수 AI_PROVIDER).
//  - none (기본): AI 를 부르지 않는다. 메모 정리는 "원문 그대로", 조언은 키워드가 겹치는 메모만 보여준다.
//  - fake: 개발용 가짜 응답. 운영 환경에서는 켜지지 않는다.
//  - openai: OpenAI Responses API (기본 gpt-6.1-terra, 추론 강도 OPENAI_REASONING_EFFORT, 기본 none).
import { AppError } from "../errors.ts";
import { FakeProvider } from "./fake.ts";
import { OpenAiProvider, openAiConfigFromEnv } from "./openai.ts";
import type { AiProvider } from "./types.ts";

type Env = Record<string, string | undefined>;

export const SUPPORTED_PROVIDERS = ["none", "fake", "openai"] as const;

export const aiUnavailable = () =>
  new AppError(503, "ai_unavailable", "AI가 연결되지 않았습니다. 원문 그대로 확인해 공유할 수 있습니다.");

export const noAiProvider: AiProvider = {
  name: "none",
  isAi: false,
  restate: async () => {
    throw aiUnavailable();
  },
  judge: async () => {
    throw aiUnavailable();
  },
  advise: async () => {
    throw aiUnavailable();
  },
  chat: async () => {
    throw aiUnavailable();
  },
  summarize: async () => {
    throw aiUnavailable();
  },
};

let devFake: FakeProvider | undefined;
let openai: { key: string; provider: OpenAiProvider } | undefined;

export function getProvider(env: Env = process.env): AiProvider {
  const name = (env.AI_PROVIDER ?? "none").trim();
  if (name === "" || name === "none") return noAiProvider;
  if (name === "fake") {
    if (env.NODE_ENV === "production" || env.VERCEL) {
      throw new Error("AI_PROVIDER=fake is not allowed in production or on Vercel");
    }
    return (devFake ??= new FakeProvider());
  }
  if (name === "openai") {
    const cfg = openAiConfigFromEnv(env);
    const key = JSON.stringify([cfg.model, cfg.reasoningEffort, cfg.baseUrl, cfg.apiKey ? "k" : "-"]);
    if (openai?.key !== key) openai = { key, provider: new OpenAiProvider(cfg) };
    return openai.provider;
  }
  throw new Error(`Unsupported AI_PROVIDER: ${name}`);
}

export function describeProvider(env: Env = process.env) {
  try {
    const p = getProvider(env);
    return {
      provider: p.name,
      available: p.isAi,
      fake: p.name === "fake",
      model: p instanceof OpenAiProvider ? p.model : null,
      reasoningEffort: p instanceof OpenAiProvider ? p.reasoningEffort : null,
    };
  } catch {
    return { provider: "misconfigured" as const, available: false, fake: false, model: null, reasoningEffort: null };
  }
}
