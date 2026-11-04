// OpenAI Responses API 제공자 (기본 모델 gpt-6.1-terra, 추론 강도 none).
// 보안·비용 원칙:
//  - 키는 서버 환경변수에서만 읽는다. 키가 없으면 Authorization 헤더를 보내지 않는다
//    (클라우드 개발 환경처럼 프록시가 키를 주입하는 경우를 위해).
//  - store:false 로 보내 OpenAI 쪽에 대화를 저장하지 않는다.
//  - 출력은 JSON 스키마로 고정하고, 그래도 서버의 validate-output 검증을 다시 거친다.
//  - 사용량(토큰)을 기록해 실제 비용을 계산할 수 있게 한다.
import { ADVISE_SCHEMA, ADVISE_SYSTEM, adviseUser, JUDGE_SCHEMA, JUDGE_SYSTEM, judgeUser, type JsonSchema, RESTATE_SCHEMA, RESTATE_SYSTEM, restateUser } from "./prompts.ts";
import type { AdviseInput, AiProvider, AiUsage, JudgeInput, RestateInput } from "./types.ts";
import { InvalidAiOutput } from "./validate-output.ts";

export const DEFAULT_MODEL = "gpt-6.1-terra";
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export class OpenAiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

export type OpenAiConfig = {
  apiKey?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  baseUrl?: string;
  /** 시도 1회의 시간 제한(밀리초). 전체 제한은 호출자(withTimeout)가 건다 */
  attemptTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type Env = Record<string, string | undefined>;

export function openAiConfigFromEnv(env: Env): OpenAiConfig {
  const effort = (env.OPENAI_REASONING_EFFORT ?? "none").trim() as ReasoningEffort;
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    model: env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
    reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : "none",
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
  };
}

type Call = AiUsage["call"];

export type StructuredRequest = {
  call: Call;
  system: string;
  user: string;
  schemaName: string;
  schema: JsonSchema;
  maxOutputTokens: number;
};

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [500, 1500];

export class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly isAi = true;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly attemptTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private usage: AiUsage[] = [];

  constructor(cfg: OpenAiConfig = {}) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? DEFAULT_MODEL;
    this.reasoningEffort = cfg.reasoningEffort ?? "none";
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.attemptTimeoutMs = cfg.attemptTimeoutMs ?? 25_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  restate(input: RestateInput) {
    return this.structured({ call: "restate", system: RESTATE_SYSTEM, user: restateUser(input), schemaName: "restate", schema: RESTATE_SCHEMA, maxOutputTokens: 500 });
  }

  judge(input: JudgeInput) {
    return this.structured({ call: "judge", system: JUDGE_SYSTEM, user: judgeUser(input), schemaName: "judge", schema: JUDGE_SCHEMA, maxOutputTokens: 3000 });
  }

  advise(input: AdviseInput) {
    return this.structured({ call: "advise", system: ADVISE_SYSTEM, user: adviseUser(input), schemaName: "advise", schema: ADVISE_SCHEMA, maxOutputTokens: 2500 });
  }

  drainUsage(): AiUsage[] {
    const u = this.usage;
    this.usage = [];
    return u;
  }

  /** 스키마로 고정된 JSON 응답을 받는다. 429·5xx·네트워크 오류는 2회까지 다시 시도한다. */
  async structured(req: StructuredRequest): Promise<unknown> {
    const body = {
      model: this.model,
      store: false,
      reasoning: { effort: this.reasoningEffort },
      instructions: req.system,
      input: [{ role: "user", content: req.user }],
      text: { format: { type: "json_schema", name: req.schemaName, strict: true, schema: req.schema } },
      max_output_tokens: req.maxOutputTokens,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.attemptTimeoutMs),
        });
      } catch (err) {
        lastErr = new OpenAiError(`network: ${(err as Error)?.name ?? "error"}`, null, "network");
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let code: string | null = null;
        let message = `HTTP ${res.status}`;
        try {
          const e = JSON.parse(text)?.error;
          if (e) {
            code = e.code ?? e.type ?? null;
            message = `HTTP ${res.status}: ${String(e.message ?? "").slice(0, 200)}`;
          }
        } catch {
          /* 본문이 JSON 이 아님 */
        }
        lastErr = new OpenAiError(message, res.status, code);
        if (RETRY_STATUSES.has(res.status)) continue;
        throw lastErr;
      }
      return this.parse(text, req.call, Date.now() - started);
    }
    throw lastErr;
  }

  private parse(text: string, call: Call, ms: number): unknown {
    let data: Record<string, any>;
    try {
      data = JSON.parse(text);
    } catch {
      throw new InvalidAiOutput("response is not JSON");
    }
    const u = data.usage ?? {};
    this.usage.push({
      model: String(data.model ?? this.model),
      call,
      inputTokens: Number(u.input_tokens ?? 0),
      cachedTokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? 0),
      reasoningTokens: Number(u.output_tokens_details?.reasoning_tokens ?? 0),
      ms,
    });
    if (data.status === "incomplete") {
      throw new InvalidAiOutput(`incomplete: ${data.incomplete_details?.reason ?? "unknown"}`);
    }
    const outputs: Record<string, any>[] = Array.isArray(data.output) ? data.output : [];
    const message = outputs.find((o) => o.type === "message");
    const part = (message?.content ?? []).find((c: Record<string, unknown>) => c.type === "output_text");
    if (message?.content?.some((c: Record<string, unknown>) => c.type === "refusal")) {
      throw new InvalidAiOutput("model refused");
    }
    if (typeof part?.text !== "string") throw new InvalidAiOutput("no output_text");
    try {
      return JSON.parse(part.text);
    } catch {
      throw new InvalidAiOutput("output_text is not JSON");
    }
  }
}
