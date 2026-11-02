import { describe, expect, it } from "vitest";
import { describeProvider, getProvider } from "../src/lib/ai/providers.ts";
import { InvalidAiOutput, parseJudgments, proposalKey, validateAdviceOutput } from "../src/lib/ai/validate-output.ts";
import { keywordTokens } from "../src/lib/keywords.ts";
import { restatementWarnings } from "../src/lib/restate-check.ts";

describe("AI 제공자 선택", () => {
  it("기본값은 AI 미연결", () => {
    expect(getProvider({}).name).toBe("none");
    expect(getProvider({}).isAi).toBe(false);
  });
  it("개발용 가짜 제공자는 운영 환경·Vercel 에서 켤 수 없다", () => {
    expect(() => getProvider({ AI_PROVIDER: "fake", NODE_ENV: "production" })).toThrow();
    expect(() => getProvider({ AI_PROVIDER: "fake", NODE_ENV: "development", VERCEL: "1" })).toThrow();
    expect(getProvider({ AI_PROVIDER: "fake", NODE_ENV: "development" }).name).toBe("fake");
    expect(describeProvider({ AI_PROVIDER: "fake", NODE_ENV: "production" }).provider).toBe("misconfigured");
  });
  it("모르는 제공자 이름은 거부한다", () => {
    expect(() => getProvider({ AI_PROVIDER: "gpt" })).toThrow();
  });
});

const sources = new Map([
  ["N1", { versionId: "v1", rawText: "두 실험은 측정 조건이 달라 보임.  숫자만 비교하면 오해할 수도", summary: null }],
  ["N2", { versionId: "v2", rawText: "회의실 예약 목요일", summary: "회의실 예약을 목요일로 옮김" }],
]);

describe("모델 출력 검증", () => {
  it("형식이 아예 틀리면 예외", () => {
    expect(() => validateAdviceOutput("그냥 문자열", sources)).toThrow(InvalidAiOutput);
    expect(() => validateAdviceOutput({ items: "x" }, sources)).toThrow(InvalidAiOutput);
    expect(() => parseJudgments(null, new Set(["N1"]))).toThrow(InvalidAiOutput);
  });

  it("지어낸 근거·원문에 없는 인용·구획 규칙 위반은 버린다", () => {
    const { items, dropped } = validateAdviceOutput(
      {
        items: [
          { section: "direct", body: "정상", evidence: [{ ref: "N1", quote: "측정 조건이 달라" }] },
          { section: "direct", body: "지어낸 근거", evidence: [{ ref: "N99", quote: "측정" }] },
          { section: "direct", body: "가짜 인용", evidence: [{ ref: "N1", quote: "A 방식이 우수하다" }] },
          { section: "direct", body: "인용 없음", evidence: [{ ref: "N1" }] },
          { section: "extra", body: "근거 붙은 일반 제안", evidence: [{ ref: "N1" }] },
          { section: "link_reason", body: "근거 없는 연결", evidence: [] },
          { section: "decision", body: "팀 결정으로 승격", evidence: [{ ref: "N1" }] },
          { section: "extra", body: "", evidence: [] },
          { section: "extra", body: "정상 일반 제안" },
        ],
      },
      sources,
    );
    expect(items.map((i) => i.body)).toEqual(["정상", "정상 일반 제안"]);
    expect(dropped).toBe(7);
    expect(items[0]!.evidence).toEqual([{ versionId: "v1", quote: "측정 조건이 달라" }]);
  });

  it("공백이 달라도 같은 문구면 인용으로 인정하고, 확인된 정리문 인용도 인정한다", () => {
    const { items } = validateAdviceOutput(
      {
        items: [
          { section: "direct", body: "a", evidence: [{ ref: "N1", quote: "보임. 숫자만" }] },
          { section: "direct", body: "b", evidence: [{ ref: "N2", quote: "목요일로 옮김" }] },
        ],
      },
      sources,
    );
    expect(items).toHaveLength(2);
  });

  it("제어 문자·글자 방향 조작 문자를 지운다", () => {
    const { items } = validateAdviceOutput({ items: [{ section: "extra", body: "안‮녕\u0007하세요" }] }, sources);
    expect(items[0]!.body).toBe("안녕하세요");
  });

  it("항목 수 상한(12개)을 넘으면 나머지는 버린다", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ section: "extra", body: `제안 ${i}` }));
    const { items, dropped } = validateAdviceOutput({ items: many }, sources);
    expect(items).toHaveLength(12);
    expect(dropped).toBe(8);
  });

  it("관련성 판정에서 모르는 번호·중복·형식 오류는 버린다", () => {
    const r = parseJudgments(
      {
        judgments: [
          { ref: "N1", relevant: true, stance: "objection" },
          { ref: "N1", relevant: false },
          { ref: "N7", relevant: true },
          { ref: "N2", relevant: "yes" },
          { ref: "N2", relevant: true, stance: "확실" },
        ],
      },
      new Set(["N1", "N2"]),
    );
    expect(r.relevant).toEqual([
      { ref: "N1", stance: "objection" },
      { ref: "N2", stance: "unclear" },
    ]);
    expect(r.dropped).toBe(3);
  });

  it("같은 근거·같은 행동이면 요청마다 번호가 달라도 같은 제안 키", () => {
    const a = proposalKey({ section: "direct", body: "x", action: "메모 확인 N1", evidence: [{ versionId: "v1", quote: null }] });
    const b = proposalKey({ section: "direct", body: "y", action: "메모 확인 N3", evidence: [{ versionId: "v1", quote: null }] });
    const c = proposalKey({ section: "direct", body: "x", action: "메모 확인 N1", evidence: [{ versionId: "v2", quote: null }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("보조 함수", () => {
  it("한국어 조사를 떼어 키워드를 만든다", () => {
    expect(keywordTokens("두 실험은 측정 조건이 달라 보임")).toEqual(["실험", "측정", "조건", "달라", "보임"]);
  });
  it("정리문에 원문에 없는 숫자가 들어가면 경고한다", () => {
    expect(restatementWarnings("비교가 이상함", { summary: "정확도 95%로 A가 우수", conditions: [], uncertainties: [] })[0]).toContain("95");
    expect(restatementWarnings("3장으로", { summary: "슬라이드 3장", conditions: [], uncertainties: [] })).toEqual([]);
  });
});
