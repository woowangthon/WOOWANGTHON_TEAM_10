// 평가 실행기 (docs/구현_구체화.md §9).
//
//   DATABASE_URL=postgres://.../mijuk_eval AI_PROVIDER=openai npm run eval
//
// 하는 일
//  1. cases.json 의 가상 팀·메모를 "실제 서비스 흐름"으로 등록한다 (초안 → AI 정리 → 작성자 확인 → 공유, 철회·초안·AI 미허용 포함).
//  2. 질문 10개를 세 조건으로 실행한다.
//     A: 일반 AI (팀 메모 없음)            — 팀 자료 제공의 추가 가치를 보는 기준
//     B: 공유 메모를 통째로 붙여 넣은 AI     — 기존 도구 조합. 권한 필터·서버 검증 없음
//     C: 이 서비스의 흐름                   — 권한 → 후보 → 판정 → 생성 → 검증
//  3. 자동 지표(핵심 회수율, 억지 연결, 철회·초안 인용, 지어낸 근거, 토큰·비용)와 사람 점검표를 eval/results/<실행ID>/ 에 남긴다.
//
// 주의: 비교의 공정성을 위해 A·B 도 같은 출력 형식(JSON 스키마)을 쓴다. 지시문은 짧고 일반적으로 둔다.
//       A·B 는 모델을 직접 부르므로 OpenAI 제공자일 때만 실행된다.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdvice, requestAdvice } from "../src/lib/advice.ts";
import { OpenAiProvider } from "../src/lib/ai/openai.ts";
import { ADVISE_SCHEMA, PROMPT_VERSION } from "../src/lib/ai/prompts.ts";
import { getProvider } from "../src/lib/ai/providers.ts";
import type { AiUsage, TaskContext } from "../src/lib/ai/types.ts";
import { signUp } from "../src/lib/auth.ts";
import { closePool, getPool } from "../src/lib/db.ts";
import { confirmVersion, createNote, shareNote, withdrawNote } from "../src/lib/notes.ts";
import { restateNote } from "../src/lib/restate.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";

type Memo = { id: string; author: string; text: string; allowExternalAi?: boolean; state?: "shared" | "withdrawn" | "draft"; tags: string[] };
type Question = {
  id: string; asker: string; task: Omit<TaskContext, "question">; question: string;
  core: string[]; ok: string[]; tricky: string[]; forbidden: string[]; check: string;
};
type Cases = { team: string; authors: string[]; memos: Memo[]; questions: Question[] };

// 가격 (USD / 1M 토큰). 환경변수로 바꿀 수 있다.
const PRICE = {
  input: Number(process.env.EVAL_PRICE_IN ?? 1.0),
  cached: Number(process.env.EVAL_PRICE_CACHED ?? 0.05),
  output: Number(process.env.EVAL_PRICE_OUT ?? 5.0),
};
const cost = (u: { input: number; cached: number; output: number }) =>
  ((u.input - u.cached) * PRICE.input + u.cached * PRICE.cached + u.output * PRICE.output) / 1_000_000;

const sumUsage = (list: AiUsage[]) =>
  list.reduce(
    (a, u) => ({ input: a.input + u.inputTokens, cached: a.cached + u.cachedTokens, output: a.output + u.outputTokens, reasoning: a.reasoning + u.reasoningTokens, ms: a.ms + u.ms, calls: a.calls + 1 }),
    { input: 0, cached: 0, output: 0, reasoning: 0, ms: 0, calls: 0 },
  );

type Scored = {
  cited: string[]; coreHits: string[]; okHits: string[]; falseLinks: string[]; forbiddenHits: string[]; trickyHits: string[];
  invented: number; coreRecall: number | null;
};

function score(q: Question, cited: string[], invented = 0): Scored {
  const set = new Set(cited);
  const core = new Set(q.core), ok = new Set(q.ok), forb = new Set(q.forbidden), tricky = new Set(q.tricky);
  const coreHits = [...set].filter((m) => core.has(m));
  return {
    cited: [...set].sort(),
    coreHits,
    okHits: [...set].filter((m) => ok.has(m)),
    falseLinks: [...set].filter((m) => !core.has(m) && !ok.has(m)),
    forbiddenHits: [...set].filter((m) => forb.has(m)),
    trickyHits: [...set].filter((m) => tricky.has(m)),
    invented,
    coreRecall: q.core.length ? coreHits.length / q.core.length : null,
  };
}

type ItemRow = { section: string; keywordOnly?: boolean; body: string | null; refs: string[] };

/** 조건 C: AI 가 인용한 근거와, AI 를 거치지 않은 키워드 항목(AI 미허용 메모)을 나눠 센다. */
function scoreC(q: Question, items: ItemRow[]) {
  const aiCited = items.filter((i) => !i.keywordOnly).flatMap((i) => i.refs);
  const keywordOnly = [...new Set(items.filter((i) => i.keywordOnly).flatMap((i) => i.refs))].sort();
  const okSet = new Set([...q.core, ...q.ok]);
  return { ...score(q, aiCited), keywordOnly, keywordOnlyFalse: keywordOnly.filter((m) => !okSet.has(m)) };
}

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"]; }));
const CONDITIONS = (args.get("conditions") ?? "A,B,C").split(",");
const DO_RESTATE = args.get("restate") !== "false";
const OUT_DIR = args.get("out") ?? "eval/results";

/** 이미 실행한 raw.json 으로 점수·보고서만 다시 만든다 (채점 기준을 고쳤을 때). */
async function rerender(rawPath: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cases = JSON.parse(await readFile(path.join(here, "cases.json"), "utf8")) as Cases;
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const byId = new Map(cases.questions.map((q) => [q.id, q]));
  for (const row of raw.results) {
    const q = byId.get(row.id);
    if (!q) continue;
    row.core = q.core; row.check = q.check;
    if (row.C) Object.assign(row.C, scoreC(q, row.C.items));
    if (row.B) Object.assign(row.B, score(q, row.B.items.flatMap((i: ItemRow) => i.refs.filter((r) => !r.startsWith("?"))), row.B.invented ?? 0));
  }
  raw.summary = summarize(raw.results, raw.conditions, [], raw.summary?.restate);
  await writeFile(rawPath, JSON.stringify(raw, null, 2));
  await writeFile(path.join(path.dirname(rawPath), "report.md"), renderReport(raw, cases));
  console.log(`다시 만듦: ${path.join(path.dirname(rawPath), "report.md")}`);
}

async function main() {
  if (args.get("render")) return rerender(args.get("render")!);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 이 필요합니다 (평가 전용 DB 권장: 이름에 eval 또는 test).");
  process.env.SESSION_SECRET ??= "eval-only-secret-not-for-production-0123456789";
  const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
  if (!/eval|test/i.test(dbName)) throw new Error(`평가는 가상 팀·사용자를 만듭니다. 전용 DB 를 쓰세요 (현재: ${dbName}).`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const cases = JSON.parse(await readFile(path.join(here, "cases.json"), "utf8")) as Cases;
  const provider = getProvider();
  const openai = provider instanceof OpenAiProvider ? provider : null;
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(OUT_DIR, runId);
  await mkdir(outDir, { recursive: true });
  const log = (s: string) => console.log(s);
  log(`실행 ${runId} · 제공자 ${provider.name}${openai ? ` (${openai.model}, effort=${openai.reasoningEffort})` : ""} · 조건 ${CONDITIONS.join("/")} · AI 정리 ${DO_RESTATE && provider.isAi ? "켬" : "끔"}`);

  // 1) 가상 팀 만들기 (실제 서비스 함수로)
  const users = new Map<string, string>();
  for (const name of cases.authors) {
    const { userId } = await signUp({ email: `${name}.${runId}@eval.invalid`, password: "eval-only-password", displayName: name });
    users.set(name, userId);
  }
  const lead = users.get(cases.authors[0]!)!;
  const team = await createTeam(lead, `${cases.team} (${runId})`);
  for (const name of cases.authors.slice(1)) await joinTeam(users.get(name)!, team.inviteCode);

  // 2) 메모 등록
  const versionToMemo = new Map<string, string>();
  const restatements: { id: string; raw: string; summary: string | null; kind: string | null; warnings: string[]; error: string | null }[] = [];
  const restateUsage: AiUsage[] = [];
  const sharedMemos: Memo[] = [];
  for (const m of cases.memos) {
    const author = users.get(m.author)!;
    const n = await createNote(author, team.id, { rawText: m.text, allowExternalAi: m.allowExternalAi ?? true });
    if (m.state === "draft") continue;
    let hash = n.contentHash;
    let choice: "confirmed" | "raw_only" = "raw_only";
    if (DO_RESTATE && provider.isAi && (m.allowExternalAi ?? true)) {
      try {
        const r = await restateNote(author, n.noteId, n.versionId, provider);
        restateUsage.push(...(await lastRestateUsage(n.noteId)));
        restatements.push({ id: m.id, raw: m.text, summary: r.restated.summary, kind: r.restated.kind, warnings: r.warnings, error: null });
        hash = r.contentHash;
        choice = "confirmed";
      } catch (err) {
        restatements.push({ id: m.id, raw: m.text, summary: null, kind: null, warnings: [], error: (err as Error).message });
      }
    }
    await confirmVersion(author, n.noteId, n.versionId, { choice, expectedHash: hash });
    await shareNote(author, n.noteId, n.versionId);
    versionToMemo.set(n.versionId, m.id);
    if (m.state === "withdrawn") await withdrawNote(author, n.noteId);
    else sharedMemos.push(m);
  }
  log(`메모 ${cases.memos.length}개 등록 (공유 ${sharedMemos.length}, AI 정리 ${restatements.filter((r) => !r.error).length}, 정리 실패 ${restatements.filter((r) => r.error).length})`);

  // 3) 질문 실행
  const results: Record<string, any>[] = [];
  for (const q of cases.questions) {
    const asker = users.get(q.asker)!;
    const task = await createTask(asker, team.id, q.task);
    const ctx: TaskContext = { ...q.task, question: q.question };
    const row: Record<string, any> = { id: q.id, title: q.task.title, question: q.question, core: q.core, check: q.check };

    if (CONDITIONS.includes("C")) {
      const a = await requestAdvice(asker, task.id, { question: q.question }, provider);
      const full = await getAdvice(asker, a.id);
      const items = full.items.map((i) => ({ section: i.section, keywordOnly: i.keywordOnly, body: i.body, refs: i.evidence.map((e) => versionToMemo.get(e.versionId) ?? `?${e.versionId.slice(0, 8)}`) }));
      const u = (await getPool().query("select usage from advice_requests where id = $1", [a.id])).rows[0]?.usage ?? null;
      row.C = {
        status: full.status, error: full.error, emptyReason: full.emptyReason, dropped: full.droppedCount, candidates: full.candidateCount,
        items,
        usage: u ? { input: u.input, cached: u.cached, output: u.output, reasoning: u.reasoning, ms: u.ms, calls: u.calls?.length ?? 0 } : null,
        ...scoreC(q, items),
      };
      row.C.cost = row.C.usage ? cost(row.C.usage) : 0;
      log(`${q.id} C: 상태 ${full.status} · 핵심 ${row.C.coreHits.length}/${q.core.length} · 억지 ${row.C.falseLinks.length} · 키워드만 ${row.C.keywordOnly.length} · 금지 ${row.C.forbiddenHits.length} · 항목 ${full.items.length} · $${row.C.cost.toFixed(4)}`);
    }

    if (openai && CONDITIONS.includes("B")) {
      const listed = sharedMemos.map((m, i) => ({ ref: `M${i + 1}`, memo: m }));
      const refToMemo = new Map(listed.map((x) => [x.ref, x.memo.id]));
      const pasted = listed.map((x) => `${x.ref}: ${x.memo.text}`).join("\n");
      const r = await direct(openai, {
        system: "너는 팀 프로젝트를 돕는 AI 비서다. 아래 팀 메모 목록을 참고해 작업에 조언한다. 참고한 메모는 evidence.ref 에 번호(예: M3)로 적고, quote 에는 그 메모의 문구를 적는다. 메모에 없는 내용은 근거 없이 쓰지 않는다. 한국어로 답한다.",
        user: `${taskText(ctx)}\n\n팀 메모 목록:\n${pasted}`,
      });
      const refs = r.items.flatMap((i) => i.evidence.map((e) => e.ref));
      const invented = refs.filter((ref) => !refToMemo.has(ref)).length;
      const cited = refs.map((ref) => refToMemo.get(ref)).filter((x): x is string => !!x);
      row.B = { items: r.items.map((i) => ({ section: i.section, body: i.body, refs: i.evidence.map((e) => refToMemo.get(e.ref) ?? `?${e.ref}`) })), usage: r.usage, cost: cost(r.usage), sentPrivate: listed.some((x) => x.memo.allowExternalAi === false), ...score(q, cited, invented) };
      log(`${q.id} B: 핵심 ${row.B.coreHits.length}/${q.core.length} · 억지 ${row.B.falseLinks.length} · 지어냄 ${invented} · 항목 ${r.items.length} · $${row.B.cost.toFixed(4)}`);
    }

    if (openai && CONDITIONS.includes("A")) {
      const r = await direct(openai, {
        system: "너는 팀 프로젝트를 돕는 AI 비서다. 작업에 조언한다. 팀 자료가 없으므로 evidence 는 비워 둔다. 한국어로 답한다.",
        user: taskText(ctx),
      });
      row.A = { items: r.items.map((i) => ({ section: i.section, body: i.body })), usage: r.usage, cost: cost(r.usage) };
      log(`${q.id} A: 항목 ${r.items.length} · $${row.A.cost.toFixed(4)}`);
    }
    results.push(row);
  }

  // 4) 요약
  const summary = summarize(results, CONDITIONS, restateUsage);
  const raw = { runId, provider: provider.name, model: openai?.model ?? null, reasoningEffort: openai?.reasoningEffort ?? null, promptVersion: PROMPT_VERSION, price: PRICE, conditions: CONDITIONS, restate: DO_RESTATE, summary, restatements, results };
  await writeFile(path.join(outDir, "raw.json"), JSON.stringify(raw, null, 2));
  await writeFile(path.join(outDir, "report.md"), renderReport(raw, cases));
  log(`\n결과: ${outDir}/report.md`);
  log(JSON.stringify(summary, null, 2));
}

async function lastRestateUsage(noteId: string): Promise<AiUsage[]> {
  const r = await getPool().query("select detail from audit_log where action = 'note.restate' and target = $1 order by id desc limit 1", [noteId]);
  return (r.rows[0]?.detail?.usage as AiUsage[] | undefined) ?? [];
}

function taskText(c: TaskContext): string {
  return [`작업: ${c.title}`, c.purpose && `목적: ${c.purpose}`, c.audience && `대상: ${c.audience}`, c.constraints && `제약: ${c.constraints}`, c.question && `질문: ${c.question}`].filter(Boolean).join("\n");
}

type DirectItem = { section: string; body: string; evidence: { ref: string; quote: string | null }[]; action: string };

async function direct(openai: OpenAiProvider, p: { system: string; user: string }) {
  openai.drainUsage();
  let items: DirectItem[] = [];
  let error: string | null = null;
  try {
    const out = (await openai.structured({ call: "eval", system: p.system, user: p.user, schemaName: "advise", schema: ADVISE_SCHEMA, maxOutputTokens: 2500 })) as { items?: DirectItem[] };
    items = Array.isArray(out?.items) ? out.items : [];
  } catch (err) {
    error = (err as Error).message;
  }
  const usage = sumUsage(openai.drainUsage());
  return { items, usage, error };
}

function summarize(results: Record<string, any>[], conditions: string[], restateUsage: AiUsage[], keepRestate?: Record<string, any>) {
  const s: Record<string, any> = { questions: results.length };
  for (const c of conditions) {
    const rows = results.map((r) => r[c]).filter(Boolean);
    if (!rows.length) continue;
    const scored = rows.filter((r) => r.coreRecall !== null);
    const u = rows.reduce((a, r) => ({ input: a.input + (r.usage?.input ?? 0), cached: a.cached + (r.usage?.cached ?? 0), output: a.output + (r.usage?.output ?? 0), ms: a.ms + (r.usage?.ms ?? 0) }), { input: 0, cached: 0, output: 0, ms: 0 });
    s[c] = {
      runs: rows.length,
      coreRecallAvg: scored.length ? +(scored.reduce((a, r) => a + r.coreRecall, 0) / scored.length).toFixed(3) : null,
      falseLinksTotal: rows.reduce((a, r) => a + (r.falseLinks?.length ?? 0), 0),
      forbiddenTotal: rows.reduce((a, r) => a + (r.forbiddenHits?.length ?? 0), 0),
      trickyTotal: rows.reduce((a, r) => a + (r.trickyHits?.length ?? 0), 0),
      inventedTotal: rows.reduce((a, r) => a + (r.invented ?? 0), 0),
      keywordOnlyTotal: rows.reduce((a, r) => a + (r.keywordOnly?.length ?? 0), 0),
      keywordOnlyFalseTotal: rows.reduce((a, r) => a + (r.keywordOnlyFalse?.length ?? 0), 0),
      itemsTotal: rows.reduce((a, r) => a + (r.items?.length ?? 0), 0),
      failed: rows.filter((r) => r.status && r.status !== "ok").length,
      tokens: u,
      avgMs: Math.round(u.ms / rows.length),
      costUsd: +rows.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(4),
    };
  }
  const ru = sumUsage(restateUsage);
  s.restate = keepRestate ?? { calls: ru.calls, tokens: { input: ru.input, cached: ru.cached, output: ru.output }, costUsd: +cost(ru).toFixed(4), avgMs: ru.calls ? Math.round(ru.ms / ru.calls) : 0 };
  s.totalCostUsd = +(Object.values(s).reduce((a: number, v: any) => a + (v?.costUsd ?? 0), 0) as number).toFixed(4);
  return s;
}

function renderReport(raw: Record<string, any>, cases: Cases): string {
  const L: string[] = [];
  const s = raw.summary;
  L.push(`# 평가 실행 보고 — ${raw.runId}`, "");
  L.push(`- 제공자: ${raw.provider}${raw.model ? ` · 모델 ${raw.model} · 추론 강도 ${raw.reasoningEffort}` : ""} · 프롬프트 ${raw.promptVersion}`);
  L.push(`- 메모 ${cases.memos.length}개, 질문 ${cases.questions.length}개, 조건 ${raw.conditions.join("/")}, AI 정리 ${raw.restate ? "켬" : "끔"}`);
  L.push(`- 가격 가정(USD/1M 토큰): 입력 ${raw.price.input}, 캐시 ${raw.price.cached}, 출력 ${raw.price.output} → **총 비용 $${s.totalCostUsd}**`, "");
  L.push("## 자동 지표 요약", "", "| 조건 | 실행 | 핵심 회수율(평균) | 억지 연결(AI) | 키워드만 항목(그중 무관) | 금지(철회·초안) 인용 | 단어만 겹친 메모 인용 | 지어낸 근거 | 항목 수 | 실패 | 토큰(입력/출력) | 평균 시간 | 비용 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |");
  for (const c of ["C", "B", "A"]) {
    const v = s[c];
    if (!v) continue;
    const kw = c === "C" ? `${v.keywordOnlyTotal} (${v.keywordOnlyFalseTotal})` : "-";
    L.push(`| ${c} | ${v.runs} | ${v.coreRecallAvg ?? "-"} | ${v.falseLinksTotal} | ${kw} | ${v.forbiddenTotal} | ${v.trickyTotal} | ${v.inventedTotal} | ${v.itemsTotal} | ${v.failed} | ${v.tokens.input}/${v.tokens.output} | ${(v.avgMs / 1000).toFixed(1)}s | $${v.costUsd} |`);
  }
  L.push(`| 정리 | ${s.restate.calls ?? 0} | - | - | - | - | - | - | - | - | ${s.restate.tokens?.input ?? 0}/${s.restate.tokens?.output ?? 0} | ${((s.restate.avgMs ?? 0) / 1000).toFixed(1)}s | $${s.restate.costUsd ?? 0} |`, "");
  L.push("조건 A 는 팀 메모를 주지 않으므로 회수율·근거 지표가 없다. 조건 B 는 AI 미허용 메모까지 모델에 보낸다(권한 개념 없음). 억지 연결 = AI 가 core·ok 밖의 메모를 근거로 인용한 수. 키워드만 항목 = AI 미허용 메모가 키워드 일치로 붙은 수(AI 를 거치지 않음).", "");

  L.push("## 질문별 결과", "", "| 질문 | 조건 | 상태 | 핵심 | 찾은 메모 | 억지 연결 | 금지 인용 | 비고 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of raw.results) {
    for (const c of ["C", "B"]) {
      const v = r[c];
      if (!v) continue;
      const note = c === "C" ? [v.emptyReason && `빈 이유 ${v.emptyReason}`, v.dropped ? `버림 ${v.dropped}` : "", v.keywordOnly?.length ? `키워드만 ${v.keywordOnly.join(",")}` : "", v.status === "failed" && v.error ? `오류 ${v.error}` : ""].filter(Boolean).join(" · ") : v.invented ? `지어낸 근거 ${v.invented}` : "";
      L.push(`| ${r.id} ${r.title} | ${c} | ${v.status ?? "-"} | ${v.coreHits.length}/${r.core.length} | ${v.cited.join(", ") || "-"} | ${v.falseLinks.join(", ") || "-"} | ${v.forbiddenHits.join(", ") || "-"} | ${note} |`);
    }
  }
  L.push("");

  if (raw.restatements.length) {
    L.push("## AI 정리 결과 (작성자 확인 전 상태를 그대로 기록)", "", "| 메모 | 원문 | AI 정리 | 성격 | 경고/오류 |", "| --- | --- | --- | --- | --- |");
    for (const r of raw.restatements) L.push(`| ${r.id} | ${esc(r.raw)} | ${esc(r.summary ?? "")} | ${r.kind ?? ""} | ${esc([...r.warnings, r.error ?? ""].filter(Boolean).join("; "))} |`);
    L.push("");
  }

  L.push("## 사람 점검표", "", "각 질문의 점검 기준을 보고 ✅/❌ 를 적는다. 숫자·조건·추측·상충이 보존됐는지, 근거 없는 내용을 팀 의견처럼 썼는지 본다.", "");
  for (const r of raw.results) {
    L.push(`### ${r.id} ${r.title} — "${r.question}"`, "", `점검 기준: ${r.check}`, "");
    for (const c of ["C", "B", "A"]) {
      const v = r[c];
      if (!v) continue;
      L.push(`**조건 ${c}** (항목 ${v.items.length}개)`, "");
      if (!v.items.length) L.push(`- (항목 없음${v.emptyReason ? `: ${v.emptyReason}` : ""}${v.error ? `, 오류 ${v.error}` : ""})`);
      for (const it of v.items) L.push(`- [${it.section}${it.keywordOnly ? "·키워드만" : ""}]${it.refs?.length ? ` (${it.refs.join(", ")})` : ""} ${esc(it.body ?? "(숨김)")}`);
      L.push("");
    }
  }
  return L.join("\n");
}

const esc = (s: string) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

main()
  .catch((err) => {
    console.error("평가 실패:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
