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
  section: Section;
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
