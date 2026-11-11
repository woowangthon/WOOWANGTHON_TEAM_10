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

export type CandidateForAi = {
  ref: string;
  text: string;
  summary: string | null;
  conditions: string[];
  /** 회의 기록이면 제목·날짜를 붙인다 (대화에서 개인 생각보다, 오래된 회의보다 최근 회의를 우선하게) */
  meeting?: { title: string; date: string } | null;
  /** 팀원에게 보이지 않는 지식: 원문을 그대로 옮기지 말고 필요한 만큼만 반영 */
  aiOnly?: boolean;
  /** 이 지식을 쓴(마지막으로 고친) 날짜. 지식 안의 '내일'·'다음 주'는 이 날 기준이다 */
  writtenOn?: string | null;
};

export type Stance = "support" | "caution" | "objection" | "unclear";

export type JudgeInput = { task: TaskContext; candidates: CandidateForAi[] };

export type DeclinedForAi = { reaction: "hold" | "exclude"; action: string | null; refs: string[] };

export type AdviseInput = {
  task: TaskContext;
  notes: (CandidateForAi & { stance: Stance })[];
  declined: DeclinedForAi[];
};

/** 대화의 맥락이 되는 프로젝트 */
export type ProjectContext = { title: string; purpose: string; audience: string; constraints: string };

/** 대화형 질문. knowledge 는 권한·상태 필터를 거친 팀 공유 메모(요청 한정 번호). 비어 있어도 답한다. */
export type ChatInput = {
  project: ProjectContext;
  /** answer 가 null 이면 그 턴은 질문만 건넨다(답변이 지금은 쓸 수 없는 지식에 기댔을 수 있음) */
  history: { question: string; answer: string | null }[];
  knowledge: CandidateForAi[];
  question: string;
  /** 서버가 답변을 다시 쓰게 할 때 덧붙이는 지시 (출처 표현이 나왔을 때) */
  retryNote?: string;
  /** 이 사용자와 이 프로젝트에서 나눈 더 오래된 대화의 요약 (사용자별 대화 기억) */
  memory?: string | null;
  /** 질문한 본인의 표시 이름 ("내가 할 일"을 알아듣게). 다른 사람의 이름·출처 작성자는 넘기지 않는다 */
  askerName?: string | null;
  /** 오늘 날짜와 요일 (한국 시간). '이번 주'·'마감까지 며칠' 같은 일정 판단의 기준 */
  today?: string | null;
};

/** 대화 기억 만들기: 이전 요약 + 새로 접어 넣을 대화 → 새 요약 */
export type RecapInput = { previous: string | null; turns: { question: string; answer: string | null }[] };

/** 작성자가 고른 자기 메모들을 하나의 정리문으로 */
export type SummarizeInput = { memos: string[] };

/**
 * 기대하는 출력 형태 (검증은 서버가 함):
 *  restate → { summary, kind: proposal|guess|question|objection, conditions[], uncertainties[], clarifying_question|null }
 *  judge   → { judgments: [{ ref, relevant: boolean, stance, why }] }
 *  advise  → { items: [{ section, body, evidence: [{ ref, quote? }], action? }] }
 *            section: direct | link_reason | ai_extension | objection | extra
 *  chat      → { answer, used_refs[] }   (used_refs 는 화면에 보이지 않는 내부 기록)
 *  summarize → { text }
 */
export type AiUsage = {
  model: string;
  call: "restate" | "judge" | "advise" | "chat" | "summarize" | "recap" | "eval";
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  ms: number;
};

/**
 * 모델 호출 옵션. signal 이 취소되면 진행 중인 요청을 끊고 재시도도 하지 않는다.
 * 호출자가 시간 초과로 포기한 뒤에도 요청이 계속되면 비용만 나가고 결과는 버려진다 (ai/timeout.ts 가 이 신호를 준다).
 */
export type AiCallOptions = { signal?: AbortSignal };

export interface AiProvider {
  readonly name: "none" | "fake" | "openai";
  /** true 일 때만 출력이 모델 생성물이다. false 면 AI 를 호출하지 않는다. */
  readonly isAi: boolean;
  restate(input: RestateInput, opts?: AiCallOptions): Promise<unknown>;
  judge(input: JudgeInput, opts?: AiCallOptions): Promise<unknown>;
  advise(input: AdviseInput, opts?: AiCallOptions): Promise<unknown>;
  chat(input: ChatInput, opts?: AiCallOptions): Promise<unknown>;
  summarize(input: SummarizeInput, opts?: AiCallOptions): Promise<unknown>;
  recap(input: RecapInput, opts?: AiCallOptions): Promise<unknown>;
  /** 마지막으로 가져간 이후의 사용량(토큰·시간). 비용 기록용. 없으면 빈 배열. */
  drainUsage?(): AiUsage[];
}
