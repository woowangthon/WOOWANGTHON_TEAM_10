// 모델 출력 검증. 모델이 무엇을 내놓든 여기를 통과한 것만 저장·표시한다 (원안 §7.2-9, §7.3).
//  - 근거 번호(ref)는 이번 요청에서 서버가 건넨 것만 인정 → 지어낸 근거가 있으면 그 항목 전체를 버림
//  - 인용(quote)은 실제 원문(또는 작성자가 확인한 정리문)에 있는 문구여야 함
//  - 구획 규칙: '팀 메모에 있는 내용'은 근거+인용 필수, '일반 제안(extra)'은 팀 근거를 달 수 없음
import { createHash } from "node:crypto";
import { cleanText } from "../validate.ts";
import type { Stance } from "./types.ts";

export class InvalidAiOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAiOutput";
  }
}

export const SECTIONS = ["direct", "link_reason", "ai_extension", "objection", "extra"] as const;
export type Section = (typeof SECTIONS)[number];
const STANCES: readonly Stance[] = ["support", "caution", "objection", "unclear"];

export type SourceNote = { versionId: string; rawText: string; summary: string | null };
export type ValidItem = {
  section: Section | "answer";
  body: string;
  evidence: { versionId: string; quote: string | null }[];
  action: string | null;
};

const MAX_JUDGMENTS = 100;
const MAX_ITEMS = 12;
const MAX_BODY = 800;
const MAX_EVIDENCE = 5;
const MAX_QUOTE = 200;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseJudgments(raw: unknown, validRefs: ReadonlySet<string>) {
  if (!isObj(raw) || !Array.isArray(raw.judgments)) throw new InvalidAiOutput("judgments missing");
  const seen = new Set<string>();
  const relevant: { ref: string; stance: Stance }[] = [];
  let dropped = Math.max(0, raw.judgments.length - MAX_JUDGMENTS);
  for (const j of raw.judgments.slice(0, MAX_JUDGMENTS)) {
    if (!isObj(j) || typeof j.ref !== "string" || !validRefs.has(j.ref) || seen.has(j.ref) || typeof j.relevant !== "boolean") {
      dropped++;
      continue;
    }
    seen.add(j.ref);
    if (j.relevant) relevant.push({ ref: j.ref, stance: STANCES.includes(j.stance as Stance) ? (j.stance as Stance) : "unclear" });
  }
  return { relevant, dropped };
}

export function validateAdviceOutput(raw: unknown, sources: ReadonlyMap<string, SourceNote>) {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new InvalidAiOutput("items missing");
  const items: ValidItem[] = [];
  let dropped = Math.max(0, raw.items.length - MAX_ITEMS);
  for (const it of raw.items.slice(0, MAX_ITEMS)) {
    const v = validateItem(it, sources);
    if (v) items.push(v);
    else dropped++;
  }
  return { items, dropped };
}

function validateItem(it: unknown, sources: ReadonlyMap<string, SourceNote>): ValidItem | null {
  if (!isObj(it) || !SECTIONS.includes(it.section as Section) || typeof it.body !== "string") return null;
  const section = it.section as Section;
  const body = cleanText(it.body);
  if (!body || body.length > MAX_BODY) return null;

  const evRaw = it.evidence ?? [];
  if (!Array.isArray(evRaw) || evRaw.length > MAX_EVIDENCE) return null;
  const evidence: ValidItem["evidence"] = [];
  const seen = new Set<string>();
  for (const e of evRaw) {
    if (!isObj(e) || typeof e.ref !== "string") return null;
    const src = sources.get(e.ref);
    if (!src) return null; // 건네지 않은 근거 번호 → 지어낸 근거
    if (seen.has(e.ref)) continue;
    seen.add(e.ref);
    let quote: string | null = null;
    if (e.quote !== undefined && e.quote !== null) {
      if (typeof e.quote !== "string") return null;
      const q = squash(cleanText(e.quote));
      if (q.length < 2 || q.length > MAX_QUOTE) return null;
      const inSource = squash(src.rawText).includes(q) || (src.summary !== null && squash(src.summary).includes(q));
      if (!inSource) return null; // 원문에 없는 인용
      quote = q;
    }
    evidence.push({ versionId: src.versionId, quote });
  }

  if (section === "extra" && evidence.length > 0) return null;
  if ((section === "direct" || section === "link_reason" || section === "ai_extension") && evidence.length === 0) return null;
  if (section === "direct" && evidence.some((e) => e.quote === null)) return null;

  let action: string | null = null;
  if (it.action !== undefined && it.action !== null) {
    if (typeof it.action !== "string") return null;
    action = cleanText(it.action).slice(0, 120) || null;
  }
  return { section, body, evidence, action };
}

const normalizeAction = (s: string) =>
  s.replace(/\bN\d+\b/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** 같은 근거·같은 행동의 제안인지 판별하는 키. 요청마다 바뀌는 항목 ID 대신 쓴다 (원안 §7.4). */
export function proposalKey(item: Pick<ValidItem, "section" | "body" | "action" | "evidence">): string {
  const ids = [...new Set(item.evidence.map((e) => e.versionId))].sort();
  const basis = item.action ? normalizeAction(item.action) : `${item.section}:${normalizeAction(item.body)}`;
  return createHash("sha256").update(JSON.stringify([ids, basis])).digest("hex").slice(0, 40);
}

const MAX_ANSWER = 6000;

/**
 * 대화 답변 검증. 답변 본문과, 모델이 실제로 반영했다고 밝힌 지식 번호(이번 요청에서 건넨 것만)를 돌려준다.
 * 답변에 번호(N3 등)가 새어 나오면 지운다: 화면에는 팀 메모 참고 여부를 드러내지 않는다.
 */
export function validateChatOutput(raw: unknown, validRefs: ReadonlySet<string>) {
  if (!isObj(raw) || typeof raw.answer !== "string") throw new InvalidAiOutput("answer missing");
  let answer = raw.answer;
  for (const ref of validRefs) answer = answer.replace(new RegExp(`[\\[(（]?\\b${ref}\\b[\\])）]?`, "g"), "");
  answer = answer.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  if (!answer) throw new InvalidAiOutput("answer empty");
  if (answer.length > MAX_ANSWER) answer = answer.slice(0, MAX_ANSWER) + "…";
  const refs = Array.isArray(raw.used_refs) ? raw.used_refs : [];
  const used = [...new Set(refs.filter((r): r is string => typeof r === "string" && validRefs.has(r)))];
  return { answer, used, dropped: refs.length - used.length };
}

// ---------- 출처 표현 검사 ----------
// 출처 표시 규칙 (11/8 사용자 결정)
//  - 팀원에게 공개된 메모를 반영했으면 "팀원이 공유한 메모에 따르면"처럼 밝혀도 된다(작성자 이름은 쓰지 않음).
//  - 회의록을 반영했으면 "11월 6일 회의에서"처럼 밝혀도 된다.
//  - 'AI만 참고' 메모는 절대 밝히지 않는다. 그런 정보가 있다는 사실(비공개·숨김·개인적으로 알려준 것)도 드러내지 않는다.
// 그래서 표현을 세 종류로 나눈다.
//  - memo    : 메모를 출처로 말하는 표현. 이번 답변이 공개 메모를 실제로 반영했을 때만 허용
//  - meeting : 회의를 출처로 말하는 표현. 회의록을 반영했거나 사용자가 회의에 대해 물었을 때만 허용
//  - always  : 언제나 금지 (내부 번호·영문 내부 용어·비공개 정보의 존재를 드러내는 표현)
// 질문 자체에 그 낱말이 있으면(예: "메모 앱 추천해 줘") 그 패턴은 검사하지 않는다.
type LeakKind = "memo" | "meeting" | "always";
const SOURCE_PATTERNS: { kind: LeakKind; re: RegExp; unlessQuestion?: RegExp }[] = [
  { kind: "memo", re: /메모/, unlessQuestion: /메모/ },
  { kind: "memo", re: /노트(에|를|에서|에\s*따르면)/, unlessQuestion: /노트/ },
  { kind: "memo", re: /팀\s*(지식|자료|기록)/ },
  { kind: "memo", re: /(공유|기록|정리|저장)(된|해\s*둔|해\s*두신|하신|한)\s*(내용|정보|자료|지식|기록|메모)/ },
  { kind: "memo", re: /(기록|자료|정보|내용|지식)(에|을|를)\s*(따르면|의하면|보면|보니|참고하면)/ },
  { kind: "memo", re: /팀원(이|들이|분들이|께서)?\s*(남긴|적은|쓴|공유한|말한|올린)/ },
  { kind: "memo", re: /참고(한|했던|할)\s*(정보|자료|내용)/ },
  { kind: "meeting", re: /회의록/, unlessQuestion: /회의/ },
  { kind: "meeting", re: /회의\s*(에서|때|중에|결과|내용)\s*(정한|정했|결정|말한|나온|논의|합의|에\s*따르면|에\s*의하면|를\s*보면)/, unlessQuestion: /회의/ },
  { kind: "meeting", re: /(지난|이전|앞선|최근)\s*회의/, unlessQuestion: /회의/ },
  { kind: "meeting", re: /\d{1,2}\s*월\s*\d{1,2}\s*일\s*회의/, unlessQuestion: /회의/ },
  { kind: "always", re: /(제가|저는)\s*(알고\s*있는|가진|받은)\s*(정보|자료|내용)/ },
  { kind: "always", re: /\bknowledge\b|\bmemo\b|\bnotes?\b/i, unlessQuestion: /knowledge|memo|note/i },
  { kind: "always", re: /(비공개|공개(되지|하지)\s*않은|숨겨진|숨긴|따로\s*받은|나(에게|한테)만\s*알려\s*준|팀원(들)?에게\s*(는\s*)?보이지\s*않는)\s*(메모|정보|내용|자료|지식|기록)/ },
  { kind: "always", re: /원문(을|은)?\s*(그대로)?\s*(보여|알려|공개|옮겨|전달)/, unlessQuestion: /원문/ },
  { kind: "always", re: /(개인적으로|따로|몰래|비밀(로|리에)?)\s*(알려\s*준|알려준|전달한|남긴|공유한|말해\s*준)/ },
  { kind: "always", re: /(공개|공유)(할|해\s*드릴|해\s*줄)\s*수\s*(는\s*|가\s*)?없/ },
];

/** 이번 답변이 실제로 반영한(그리고 출처를 밝혀도 되는) 지식 종류 */
export type CitableUse = { memo?: boolean; meeting?: boolean };

/**
 * 답변에서 허용되지 않은 출처 표현을 찾는다. 빈 배열이면 깨끗하다.
 * allowed: 공개 메모·회의록을 실제로 반영했을 때 그 출처 표현은 허용한다. 생략하면 어떤 출처 표현도 허용하지 않는다.
 */
export function sourceLeaks(answer: string, question = "", allowed: CitableUse = {}): string[] {
  const found: string[] = [];
  for (const p of SOURCE_PATTERNS) {
    if (p.unlessQuestion?.test(question)) continue;
    if (p.kind === "memo" && allowed.memo) continue;
    if (p.kind === "meeting" && allowed.meeting) continue;
    const m = answer.match(p.re);
    if (m) found.push(m[0]);
  }
  return found;
}

/** 답변에 공개 메모·회의록을 출처로 밝힌 표현이 있는지 (평가용) */
export function citations(answer: string): { memo: boolean; meeting: boolean } {
  const hit = (k: LeakKind) => SOURCE_PATTERNS.some((p) => p.kind === k && p.re.test(answer));
  return { memo: hit("memo"), meeting: hit("meeting") };
}

/** 출처 표현이 든 문장(줄·문장 단위)을 뺀다. 남는 것이 없으면 빈 문자열. */
export function dropLeakySentences(answer: string, question = "", allowed: CitableUse = {}): string {
  return answer
    .split("\n")
    .map((line) => {
      const parts = line.split(/(?<=[.!?。]|[다요죠]\.)\s+/);
      return parts.filter((s) => sourceLeaks(s, question, allowed).length === 0).join(" ");
    })
    .filter((line, i, all) => line.trim() || (i > 0 && all[i - 1]!.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
