// 배포 점검 (smoke test): 배포된 주소에서 가입 → 팀 → 메모 → (AI 정리) → 공유 → 조언 → 반응 → 철회 → 숨김 → 타 팀 차단까지
// 실제 HTTP 요청으로 한 바퀴 돌리고 통과/실패를 보여준다. 브라우저·DB 접근이 필요 없다.
//
//   npm run smoke -- --url=https://<프로젝트>.vercel.app
//   npm run smoke -- --url=http://localhost:3000
//
// 시험용 계정 2~3개를 만든다(이메일 smoke+<시각>@example.invalid). 끝나면 회원 탈퇴로 계정과 자료를 모두 지운다
// (--keep 을 붙이면 남긴다). 탈퇴 기능 자체도 여기서 점검한다.
// 프록시 뒤(클라우드 세션)에서는 NODE_USE_ENV_PROXY=1 을 붙인다.

type Json = Record<string, any>;

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"]; }));
const BASE = (args.get("url") ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(BASE)) {
  console.error("사용법: npm run smoke -- --url=https://<배포 주소>");
  process.exit(2);
}
const ORIGIN = new URL(BASE).origin;
const TAG = Date.now().toString(36);

class Client {
  readonly who: string;
  private cookies = new Map<string, string>();
  constructor(who: string) {
    this.who = who;
  }
  /** 지금 쿠키를 복사한 새 클라이언트 (탈퇴 뒤 옛 쿠키가 거부되는지 보려고) */
  clone(who: string): Client {
    const c = new Client(who);
    for (const [k, v] of this.cookies) c.cookies.set(k, v);
    return c;
  }

  async call<T = Json>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; headers: Headers; ms: number }> {
    const started = Date.now();
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [k, v] = pair!.split("=");
      if (k && v !== undefined) this.cookies.set(k.trim(), v.trim());
    }
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    return { status: res.status, data, headers: res.headers, ms: Date.now() - started };
  }
}

type Status = "pass" | "fail" | "warn" | "skip";
type Result = { name: string; status: Status; note: string; ms: number };
const results: Result[] = [];
let aborted = false;

/** 필수 단계: 실패하면 뒤 단계를 건너뛴다 */
async function step(name: string, fn: () => Promise<string | void>) {
  if (aborted) { results.push({ name, status: "skip", note: "앞 단계 실패로 건너뜀", ms: 0 }); return; }
  const started = Date.now();
  try {
    const note = (await fn()) ?? "";
    results.push({ name, status: "pass", note, ms: Date.now() - started });
  } catch (err) {
    results.push({ name, status: "fail", note: (err as Error).message, ms: Date.now() - started });
    aborted = true;
  }
}
/** 참고 단계: 실패해도 경고로만 표시하고 계속한다 */
async function softStep(name: string, fn: () => Promise<string | void>) {
  if (aborted) { results.push({ name, status: "skip", note: "앞 단계 실패로 건너뜀", ms: 0 }); return; }
  const started = Date.now();
  try {
    const note = (await fn()) ?? "";
    results.push({ name, status: "pass", note, ms: Date.now() - started });
  } catch (err) {
    results.push({ name, status: "warn", note: (err as Error).message, ms: Date.now() - started });
  }
}
const MARK: Record<Status, string> = { pass: "✔", fail: "✘", warn: "⚠", skip: "–" };
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

async function main() {
  console.log(`배포 점검: ${BASE} (${new Date().toISOString()})`);
  const A = new Client("A"), B = new Client("B"), C = new Client("C");
  const pw = `Smoke-${TAG}-pass-word`;
  let teamId = "", inviteCode = "", note1 = { id: "", versionId: "", hash: "" }, note2 = { id: "", versionId: "", hash: "" };
  let taskId = "", adviceId = "", firstItemId = "";
  let ai = { provider: "none", available: false, model: null as string | null };

  await step("상태 점검 /api/health", async () => {
    const r = await A.call("GET", "/api/health");
    expect(r.status === 200 && r.data.ok === true && r.data.db === "ok", `HTTP ${r.status} ${JSON.stringify(r.data)}`);
    return `${r.ms}ms`;
  });

  await step("보안 헤더", async () => {
    const res = await fetch(`${BASE}/`, { redirect: "manual" });
    const h = res.headers;
    expect(h.get("x-content-type-options") === "nosniff", "X-Content-Type-Options 없음");
    expect(h.get("x-frame-options") === "DENY", "X-Frame-Options 없음");
    if (BASE.startsWith("https://")) {
      expect(h.get("content-security-policy"), "Content-Security-Policy 없음 (운영 빌드가 아닌가요?)");
      expect(h.get("strict-transport-security"), "Strict-Transport-Security 없음");
    }
    expect(!h.get("x-powered-by"), "X-Powered-By 가 노출됨");
    return BASE.startsWith("https://") ? "CSP·HSTS 포함" : "http 라 CSP·HSTS 는 생략";
  });

  await step("가입 A", async () => {
    const r = await A.call("POST", "/api/auth/signup", { email: `smoke+a${TAG}@example.invalid`, password: pw, displayName: "점검A" });
    expect(r.status === 200, `HTTP ${r.status} ${r.data.message ?? ""}`);
    const me = await A.call("GET", "/api/auth/me");
    expect(me.status === 200 && me.data.displayName === "점검A", "로그인 세션이 유지되지 않음 (쿠키)");
  });

  await step("AI 설정 확인", async () => {
    const r = await A.call("GET", "/api/config");
    expect(r.status === 200 && r.data.ai, `HTTP ${r.status}`);
    ai = r.data.ai;
    expect(ai.provider !== "misconfigured", "AI 설정이 잘못됨 (서버 로그 확인)");
    expect(ai.provider !== "fake", "운영 배포에 개발용 가짜 응답이 켜져 있음");
    return ai.available ? `AI 연결됨: ${ai.provider} ${ai.model ?? ""}` : "AI 미연결 (키워드 모드)";
  });

  await step("팀 만들기", async () => {
    const r = await A.call("POST", "/api/teams", { name: `점검팀 ${TAG}` });
    expect(r.status === 200 && r.data.id, `HTTP ${r.status}`);
    teamId = r.data.id; inviteCode = r.data.inviteCode;
    const inv = await A.call("GET", `/api/teams/${teamId}/invite`);
    expect(inv.data.inviteCode === inviteCode, "초대 코드 조회 실패");
  });

  await step("가입 B → 초대 코드로 합류", async () => {
    const r = await B.call("POST", "/api/auth/signup", { email: `smoke+b${TAG}@example.invalid`, password: pw, displayName: "점검B" });
    expect(r.status === 200, `HTTP ${r.status}`);
    const j = await B.call("POST", "/api/teams/join", { inviteCode });
    expect(j.status === 200, `합류 실패 HTTP ${j.status}`);
    const t = await B.call("GET", `/api/teams/${teamId}`);
    expect(t.data.members?.length === 2, "팀원 수가 2가 아님");
  });

  await step("A 메모 작성 → 확인 → 공유", async () => {
    const raw = "두 실험은 측정 조건이 달라 보임(1차 22도, 2차 26도). 숫자만 비교하면 오해할 수도";
    const n = await A.call("POST", `/api/teams/${teamId}/notes`, { rawText: raw, allowExternalAi: true });
    expect(n.status === 200, `메모 저장 실패 HTTP ${n.status}`);
    note1 = { id: n.data.noteId, versionId: n.data.versionId, hash: n.data.contentHash };
    let choice = "raw_only";
    let note = "원문 그대로";
    if (ai.available) {
      const r = await A.call("POST", `/api/notes/${note1.id}/versions/${note1.versionId}/restate`, {});
      expect(r.status === 200, `AI 정리 실패 HTTP ${r.status} ${r.data.message ?? ""}`);
      const s: string = r.data.restated?.summary ?? "";
      expect(s.includes("22") && s.includes("26"), `정리문에서 숫자가 사라짐: ${s}`);
      note1.hash = r.data.contentHash; choice = "confirmed";
      note = `AI 정리 ${r.ms}ms, 숫자 보존`;
    }
    const c = await A.call("POST", `/api/notes/${note1.id}/versions/${note1.versionId}/confirm`, { choice, expectedHash: note1.hash });
    expect(c.status === 200, `확인 실패 HTTP ${c.status} ${c.data.message ?? ""}`);
    const s = await A.call("POST", `/api/notes/${note1.id}/versions/${note1.versionId}/share`, {});
    expect(s.status === 200, `공유 실패 HTTP ${s.status}`);
    return note;
  });

  await step("A 무관한 메모 공유", async () => {
    const n = await A.call("POST", `/api/teams/${teamId}/notes`, { rawText: "회의실 예약 목요일 3시로 바꿈" });
    note2 = { id: n.data.noteId, versionId: n.data.versionId, hash: n.data.contentHash };
    await A.call("POST", `/api/notes/${note2.id}/versions/${note2.versionId}/confirm`, { choice: "raw_only", expectedHash: note2.hash });
    const s = await A.call("POST", `/api/notes/${note2.id}/versions/${note2.versionId}/share`, {});
    expect(s.status === 200, `공유 실패 HTTP ${s.status}`);
  });

  await step("B 작업 만들기 → 조언 요청", async () => {
    const t = await B.call("POST", `/api/teams/${teamId}/tasks`, {
      title: "비전공자 대상 3분 발표 구성", purpose: "실험 결과를 쉽게 설명", audience: "비전공자 심사위원", constraints: "슬라이드 3장, 숫자 비교 포함",
    });
    expect(t.status === 200, `작업 생성 실패 HTTP ${t.status}`);
    taskId = t.data.id;
    const a = await B.call("POST", `/api/tasks/${taskId}/advice`, { question: "3장을 어떻게 구성할까?", clientRequestId: crypto.randomUUID() });
    expect(a.status === 200, `조언 요청 실패 HTTP ${a.status} ${a.data.message ?? ""}`);
    expect(a.data.status === "ok", `조언 상태 ${a.data.status} (${a.data.error ?? ""})`);
    adviceId = a.data.id;
    const items: Json[] = a.data.items ?? [];
    expect(items.length > 0, "조언 항목이 없음");
    const cited = items.flatMap((i) => i.evidence.map((e: Json) => e.versionId));
    expect(cited.includes(note1.versionId), "A 의 실험 메모가 근거로 나오지 않음");
    firstItemId = items.find((i) => i.evidence.some((e: Json) => e.versionId === note1.versionId))?.id ?? items[0]!.id;
    return `${a.ms}ms, 항목 ${items.length}개, 구획 ${[...new Set(items.map((i) => i.section))].join("/")}`;
  });

  await softStep("무관한 메모가 연결되지 않음", async () => {
    const a = await B.call("GET", `/api/advice/${adviceId}`);
    const cited = (a.data.items ?? []).flatMap((i: Json) => i.evidence.map((e: Json) => e.versionId));
    expect(!cited.includes(note2.versionId), "회의실 예약 메모가 근거로 쓰임 (AI 판정 품질)");
  });

  await step("B 반응 기록 (적용)", async () => {
    const r = await B.call("POST", `/api/advice-items/${firstItemId}/reaction`, { reaction: "apply", reason: "점검" });
    expect(r.status === 200, `HTTP ${r.status} ${r.data.message ?? ""}`);
  });

  await step("A 철회 → B 조언에서 숨김", async () => {
    const w = await A.call("POST", `/api/notes/${note1.id}/withdraw`, {});
    expect(w.status === 200, `철회 실패 HTTP ${w.status}`);
    const a = await B.call("GET", `/api/advice/${adviceId}`);
    expect(a.data.status === "invalidated", `조언 상태가 ${a.data.status} (invalidated 여야 함)`);
    const leaked = JSON.stringify(a.data).includes("측정 조건");
    expect(!leaked, "철회된 메모 내용이 조언에 남아 있음");
  });

  await step("타 팀 사용자 차단", async () => {
    const r = await C.call("POST", "/api/auth/signup", { email: `smoke+c${TAG}@example.invalid`, password: pw, displayName: "점검C" });
    expect(r.status === 200, `HTTP ${r.status}`);
    const n = await C.call("GET", `/api/notes/${note2.id}`);
    expect(n.status === 404, `다른 팀 메모가 ${n.status} 로 응답 (404 여야 함)`);
    const l = await C.call("GET", `/api/teams/${teamId}/notes`);
    expect(l.status === 404, `다른 팀 목록이 ${l.status} 로 응답`);
    const a = await C.call("GET", `/api/advice/${adviceId}`);
    expect(a.status === 404, `다른 사람 조언이 ${a.status} 로 응답`);
    const x = await fetch(`${BASE}/api/teams`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    expect(x.status === 403 || x.status === 401, `외부 출처 요청이 ${x.status} 로 응답 (403 여야 함)`);
  });

  const keep = args.get("keep") === "true";
  const deleted = new Set<Client>();
  if (!keep) {
    await step("회원 탈퇴 → 계정·메모 삭제", async () => {
      const wrong = await A.call("DELETE", "/api/auth/me", { password: "wrong-password-0000" });
      expect(wrong.status === 403, `틀린 비밀번호로 탈퇴가 ${wrong.status} 로 응답 (403 여야 함)`);
      const oldCookie = A.clone("A-old");
      const r = await A.call("DELETE", "/api/auth/me", { password: pw });
      expect(r.status === 200 && r.data.deleted === true, `탈퇴 실패 HTTP ${r.status} ${r.data.message ?? ""}`);
      deleted.add(A);
      const me = await oldCookie.call("GET", "/api/auth/me");
      expect(me.status === 401, `탈퇴한 계정의 옛 쿠키가 ${me.status} 로 응답 (401 여야 함)`);
      const login = await A.call("POST", "/api/auth/login", { email: `smoke+a${TAG}@example.invalid`, password: pw });
      expect(login.status === 401, `탈퇴한 계정으로 로그인이 ${login.status} 로 응답`);
      const n = await B.call("GET", `/api/notes/${note2.id}`);
      expect(n.status === 404, `탈퇴자의 공유 메모가 ${n.status} 로 응답 (지워져야 함)`);
      const team = await B.call("GET", `/api/teams/${teamId}`);
      expect(team.status === 200, `남은 팀원이 팀을 못 봄 HTTP ${team.status}`);
      return `메모 ${r.data.notesDeleted}개 삭제, 팀장 승계`;
    });
  }

  // 앞 단계가 실패했어도 만든 시험 계정은 지운다
  if (!keep) {
    const started = Date.now();
    const left: string[] = [];
    for (const c of [A, B, C]) {
      if (deleted.has(c)) continue;
      const me = await c.call("GET", "/api/auth/me").catch(() => null);
      if (me?.status !== 200) continue; // 가입 전에 멈췄거나 이미 지워짐
      const r = await c.call("DELETE", "/api/auth/me", { password: pw }).catch(() => null);
      if (r?.status !== 200) left.push(c.who);
    }
    results.push({
      name: "정리: 시험 계정 탈퇴",
      status: left.length ? "warn" : "pass",
      note: left.length ? `지우지 못한 계정: ${left.join(", ")}` : "",
      ms: Date.now() - started,
    });
  }

  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");
  console.log("");
  for (const r of results) console.log(`${MARK[r.status]} ${r.name}${r.note ? ` — ${r.note}` : ""}${r.ms ? ` (${(r.ms / 1000).toFixed(1)}s)` : ""}`);
  console.log("");
  if (failed.length) {
    console.log(`실패 ${failed.length}건. 위 메시지와 서버 로그(Vercel → Logs)를 확인하세요.`);
    process.exitCode = 1;
  } else {
    console.log(`배포 점검 통과 (${results.length}단계${warned.length ? `, 경고 ${warned.length}건` : ""}).${keep ? ` 시험 계정: smoke+a${TAG}@example.invalid 등` : " 시험 계정은 탈퇴 처리했습니다."}`);
  }
}

main().catch((err) => {
  console.error("점검 중단:", err?.message ?? err);
  process.exitCode = 1;
});
