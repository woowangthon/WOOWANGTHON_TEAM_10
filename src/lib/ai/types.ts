// AI 연결 지점. 실제 모델(Claude 등)은 이 인터페이스만 구현하면 끼워 넣을 수 있다.
//
// 보안 원칙
//  - 모델에는 요청 한정 번호(N1, N2…)만 보낸다. 실제 ID·작성자 이름·시각은 보내지 않는다.
//  - 모델 출력의 타입은 unknown. 서버가 반드시 검증한 뒤에만 저장·표시한다 (validate-output.ts).
//  - 모델에게 DB 조회·외부 전송·권한 변경 도구를 주지 않는다. 서버가 허용한 텍스트만 건넨다.

export type TaskContext = {
  title: string;
  purpose: string;
  audience: string;
  constraints: string;
  question: string;
};

export type RestateInput = { rawText: string };

export type CandidateForAi = { ref: string; text: string; summary: string | null; conditions: string[] };

export type Stance = "support" | "caution" | "objection" | "unclear";

export type JudgeInput = { task: TaskContext; candidates: CandidateForAi[] };

export type DeclinedForAi = { reaction: "hold" | "exclude"; action: string | null; refs: string[] };

export type AdviseInput = {
  task: TaskContext;
  notes: (CandidateForAi & { stance: Stance })[];
  declined: DeclinedForAi[];
};

/**
 * 기대하는 출력 형태 (검증은 서버가 함):
 *  restate → { summary, kind: proposal|guess|question|objection, conditions[], uncertainties[], clarifying_question|null }
 *  judge   → { judgments: [{ ref, relevant: boolean, stance, why }] }
 *  advise  → { items: [{ section, body, evidence: [{ ref, quote? }], action? }] }
 *            section: direct | link_reason | ai_extension | objection | extra
 */
export interface AiProvider {
  readonly name: "none" | "fake" | "claude";
  /** true 일 때만 출력이 모델 생성물이다. false 면 AI 를 호출하지 않는다. */
  readonly isAi: boolean;
  restate(input: RestateInput): Promise<unknown>;
  judge(input: JudgeInput): Promise<unknown>;
  advise(input: AdviseInput): Promise<unknown>;
}
