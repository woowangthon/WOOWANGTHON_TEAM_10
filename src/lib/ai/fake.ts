// 개발·테스트 전용 가짜 제공자. 실제 AI가 아니다.
//  - 모든 출력에 【개발용 가짜 응답】 표시를 붙인다.
//  - 운영 환경(NODE_ENV=production, Vercel 배포)에서는 providers.ts 가 켜지지 않게 막는다.
//  - 테스트에서는 overrides 로 악의적·잘못된 출력을 흉내 내 서버 검증을 시험한다.
import { keywordTokens } from "../keywords.ts";
import { clip } from "../validate.ts";
import type { AdviseInput, AiProvider, ChatInput, JudgeInput, RecapInput, RelayInput, RestateInput, SummarizeInput } from "./types.ts";

export const FAKE_LABEL = "【개발용 가짜 응답】";

type Overrides = {
  restate?: (input: RestateInput) => unknown;
  judge?: (input: JudgeInput) => unknown;
  advise?: (input: AdviseInput) => unknown;
  chat?: (input: ChatInput) => unknown;
  summarize?: (input: SummarizeInput) => unknown;
  recap?: (input: RecapInput) => unknown;
  relay?: (input: RelayInput) => unknown;
};

export class FakeProvider implements AiProvider {
  readonly name = "fake" as const;
  readonly isAi = true;

  constructor(private readonly overrides: Overrides = {}) {}

  async restate(input: RestateInput): Promise<unknown> {
    if (this.overrides.restate) return this.overrides.restate(input);
    return {
      summary: `${FAKE_LABEL} ${clip(input.rawText, 80)}`,
      kind: "guess",
      conditions: [],
      uncertainties: [],
      clarifying_question: null,
    };
  }

  async judge(input: JudgeInput): Promise<unknown> {
    if (this.overrides.judge) return this.overrides.judge(input);
    const t = input.task;
    const tokens = keywordTokens([t.title, t.purpose, t.audience, t.constraints, t.question].join(" "));
    return {
      judgments: input.candidates.map((c) => ({
        ref: c.ref,
        relevant: tokens.some((tok) => c.text.toLowerCase().includes(tok)),
        stance: "unclear",
        why: `${FAKE_LABEL} 키워드 일치 여부로만 판단`,
      })),
    };
  }

  /** 질문과 키워드가 겹치는 지식만 "참고"한 것으로 기록하고, 답변에는 번호를 쓰지 않는다. */
  async chat(input: ChatInput): Promise<unknown> {
    if (this.overrides.chat) return this.overrides.chat(input);
    const tokens = keywordTokens(input.question);
    // 다른 팀원의 'AI만 참고' 지식은 원문 없이 전달용 정리만 온다
    const body = (k: ChatInput["knowledge"][number]) => (k.relay ? [...k.relay.facts, ...k.relay.considerations].join(" ") : k.text);
    const used = input.knowledge.filter((k) => tokens.some((t) => body(k).toLowerCase().includes(t)));
    const hint = used.length ? ` 참고: ${used.map((k) => clip(body(k), 40)).join(" / ")}` : "";
    return { answer: `${FAKE_LABEL} "${clip(input.question, 40)}"에 대한 답입니다.${hint}`, used_refs: used.map((k) => k.ref) };
  }

  async summarize(input: SummarizeInput): Promise<unknown> {
    if (this.overrides.summarize) return this.overrides.summarize(input);
    return { text: `${FAKE_LABEL} ${input.memos.map((m) => clip(m, 60)).join(" / ")}` };
  }

  /** 가짜 전달용 정리: 원문 앞부분을 '고려할 점' 하나로 돌려준다(표시 붙임). 실제 모델처럼 바람을 걸러 내지는 않는다. */
  async relay(input: RelayInput): Promise<unknown> {
    if (this.overrides.relay) return this.overrides.relay(input);
    return { items: input.memos.map((m) => ({ ref: m.ref, facts: [], considerations: [`[참고] ${FAKE_LABEL} ${clip(m.text.replace(/[\s0-9０-９]+/g, " "), 50)}`] })) };
  }

  async recap(input: RecapInput): Promise<unknown> {
    if (this.overrides.recap) return this.overrides.recap(input);
    const lines = input.turns.map((t) => `- ${clip(t.question, 60)}${t.answer ? ` → ${clip(t.answer, 60)}` : ""}`);
    return { summary: [input.previous, ...lines].filter(Boolean).join("\n").slice(0, 3500) };
  }

  async advise(input: AdviseInput): Promise<unknown> {
    if (this.overrides.advise) return this.overrides.advise(input);
    const items: unknown[] = [];
    for (const n of input.notes) {
      items.push({
        section: "direct",
        body: `${FAKE_LABEL} 메모 내용: ${clip(n.text, 60)}`,
        evidence: [{ ref: n.ref, quote: clip(n.text, 20) }],
        action: `메모 확인 ${n.ref}`,
      });
      items.push({
        section: "link_reason",
        body: `${FAKE_LABEL} 작업 "${clip(input.task.title, 30)}"과 키워드가 겹칩니다.`,
        evidence: [{ ref: n.ref }],
        action: `연결 이유 ${n.ref}`,
      });
    }
    const first = input.notes[0];
    if (first) {
      items.push({
        section: "objection",
        body: `${FAKE_LABEL} 확인 필요: 메모의 조건이 지금 작업에도 해당하는지 확인하세요.`,
        evidence: [{ ref: first.ref }],
        action: "조건 확인",
      });
    }
    items.push({
      section: "extra",
      body: `${FAKE_LABEL} 일반 제안: 발표 끝에 질문 시간을 두세요.`,
      evidence: [],
      action: "질문 시간",
    });
    return { items };
  }
}
