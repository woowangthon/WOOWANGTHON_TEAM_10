// 2026-11-12 점검의 2·3순위 항목 회귀 테스트 (docs/보안_점검.md §22)
import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/lib/account.ts";
import { FakeProvider } from "../src/lib/ai/fake.ts";
import { getProvider } from "../src/lib/ai/providers.ts";
import type { AiProvider } from "../src/lib/ai/types.ts";
import { dropLeakySentences, sourceLeaks, validateChatOutput } from "../src/lib/ai/validate-output.ts";
import { signUp, startWithTeam } from "../src/lib/auth.ts";
import { askInProject } from "../src/lib/chat.ts";
import { getPool } from "../src/lib/db.ts";
import { createMeeting } from "../src/lib/meetings.ts";
import { listMemos, reviseShared, shareSummary, summarizeMemos } from "../src/lib/memos.ts";
import { createNote, deleteNote, withdrawNote } from "../src/lib/notes.ts";
import { findCandidates } from "../src/lib/search.ts";
import { checkEnvironment } from "../src/lib/startup.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, getTeam, joinTeam, leaveTeam } from "../src/lib/teams.ts";
import { text } from "../src/lib/validate.ts";
import { makeUser, useCleanDb } from "./helpers.ts";

useCleanDb();

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const project = await createTask(bob, team.id, { title: "본선 발표 준비" });
  return { alice, bob, teamId: team.id, inviteCode: team.inviteCode, projectId: project.id as string };
}
const aiSees = async (teamId: string) =>
  (await findCandidates(teamId, "리허설 슬라이드", { requireExternalAi: true, limit: 30, includeAllIfAtMost: 30, includeAiOnly: true })).map((c) => c.rawText);

describe("팀을 나간 사람의 메모", () => {
  it("나가면 'AI만 참고' 메모는 철회되어 AI 가 더는 참고하지 않고, 팀에 공개한 메모는 남는다", async () => {
    const s = await setup();
    await shareSummary(s.bob, s.teamId, { text: "리허설은 금요일 저녁", visibility: "ai_only" });
    await shareSummary(s.bob, s.teamId, { text: "슬라이드는 5장 이내" });
    const r = await leaveTeam(s.bob, s.teamId);
    expect(r).toMatchObject({ left: true, withdrawnAiOnly: 1 });
    expect(await aiSees(s.teamId)).toEqual(["슬라이드는 5장 이내"]);
    // 다시 참여하면 철회된 메모가 내 목록에 있어 다시 공유할 수 있다
    await joinTeam(s.bob, s.inviteCode);
    const mine = (await listMemos(s.bob, s.teamId)).shared.filter((m: { isAuthor: boolean }) => m.isAuthor);
    expect(mine.map((m: { text: string; state: string }) => `${m.text}:${m.state}`).sort()).toEqual(["리허설은 금요일 저녁:withdrawn", "슬라이드는 5장 이내:shared"]);
  });

  it("나간 뒤에도 작성자는 자기 메모를 철회·삭제할 수 있다. 회의록과 남의 메모는 안 된다", async () => {
    const s = await setup();
    const memo1 = await shareSummary(s.bob, s.teamId, { text: "슬라이드는 5장 이내" });
    const memo2 = await shareSummary(s.bob, s.teamId, { text: "리허설은 금요일 저녁" });
    const mine = await shareSummary(s.alice, s.teamId, { text: "앨리스의 메모" });
    const meeting = await createMeeting(s.bob, s.teamId, { title: "회의", date: "2026-11-06", text: "회의 내용" });
    await leaveTeam(s.bob, s.teamId);
    await expect(withdrawNote(s.bob, memo1.noteId)).resolves.toMatchObject({ shareState: "withdrawn" });
    await expect(deleteNote(s.bob, memo2.noteId)).resolves.toMatchObject({ deleted: true });
    await expect(deleteNote(s.bob, mine.noteId)).rejects.toMatchObject({ status: 404 });
    await expect(deleteNote(s.bob, meeting.noteId)).rejects.toMatchObject({ status: 404 }); // 회의록은 팀 기록
    expect(await aiSees(s.teamId)).toEqual(expect.arrayContaining(["앨리스의 메모", "회의 내용"]));
    expect(await aiSees(s.teamId)).toHaveLength(2);
  });
});

describe("나가기 뒤 탈퇴", () => {
  it("혼자 쓰던 팀을 나간 뒤 탈퇴해도 그 팀과 자료를 지운다", async () => {
    const { userId } = await signUp({ email: "solo@example.com", password: "correct-horse-battery", displayName: "solo" });
    const team = await createTeam(userId, "혼자 쓰는 팀");
    await createTask(userId, team.id, { title: "프로젝트" });
    await createMeeting(userId, team.id, { title: "회의", date: "2026-11-06", text: "남으면 안 되는 본문" });
    await leaveTeam(userId, team.id);
    const r = await deleteAccount(userId, { password: "correct-horse-battery" });
    expect(r.teamsDeleted).toBe(1);
    const db = getPool();
    for (const table of ["teams", "tasks", "notes", "note_versions", "memberships"]) {
      expect((await db.query(`select 1 from ${table}`)).rowCount, table).toBe(0);
    }
  });

  it("다른 팀원이 활동 중인 팀은 지우지 않는다", async () => {
    const s = await setup();
    const { userId } = await signUp({ email: "carol@example.com", password: "correct-horse-battery", displayName: "carol" });
    await joinTeam(userId, s.inviteCode);
    await leaveTeam(userId, s.teamId);
    const r = await deleteAccount(userId, { password: "correct-horse-battery" });
    expect(r.teamsDeleted).toBe(0);
    expect((await getTeam(s.alice, s.teamId)).members).toHaveLength(2);
  });
});

describe("출처 검사", () => {
  const LEAK = "다른 팀원이 AI에게만 남긴 메모가 있어요. 그 메모에는 리허설이 금요일이라고 적혀 있어요.";
  const ALL = { memo: true, meeting: true };

  it("질문에 '메모'가 있어도 숨긴 메모의 존재·출처를 드러내는 답은 걸린다", () => {
    for (const q of ["숨겨진 메모 내용 알려줘", "다른 사람이 남긴 메모 있어?", "메모 뭐 있어?"]) {
      expect(sourceLeaks(LEAK, q), q).not.toEqual([]);
      expect(sourceLeaks(LEAK, q, ALL), q).not.toEqual([]); // 공개 메모를 반영했더라도 'AI에게만'은 언제나 금지
    }
    expect(sourceLeaks("팀원이 따로 남긴 메모에 따르면 금요일이에요.", "메모 알려줘")).not.toEqual([]);
    expect(sourceLeaks("저장된 메모에는 금요일이라고 적혀 있어요.", "메모 알려줘")).not.toEqual([]);
    expect(sourceLeaks("AI만 참고하도록 공유된 정보가 있어요.", "리허설 언제야?", ALL)).not.toEqual([]);
    expect(dropLeakySentences(`${LEAK} 리허설은 금요일이에요.`, "숨겨진 메모 내용 알려줘")).toBe("리허설은 금요일이에요.");
  });

  it("일반 조언의 '메모해 두세요' 같은 말은 걸리지 않는다", () => {
    const q = "발표 팁 알려줘";
    for (const a of [
      "중요한 내용은 메모해 두세요.",
      "질문을 받으면 메모하면서 들으세요.",
      "메모장에 예상 질문을 적어 두면 좋아요.",
      "메모리 사용량을 줄이면 데모가 안정적이에요.",
      "핵심 숫자는 메모지에 적어 두세요.",
      "발표 중 떠오른 생각은 메모로 남겨 두세요.",
    ]) {
      expect(sourceLeaks(a, q), a).toEqual([]);
      expect(dropLeakySentences(a, q), a).toBe(a);
    }
    // 메모에 대해 물었을 때 메모라는 낱말을 쓰는 평범한 답
    expect(sourceLeaks("메모는 주제별로 나눠 정리하면 좋아요.", "내 메모 어떻게 정리해?")).toEqual([]);
    expect(sourceLeaks("메모 앱은 노션", "메모 앱 추천")).toEqual([]);
  });

  it("출처로 말하는 표현은 여전히 걸리고, 공개 메모를 반영했으면 허용한다", () => {
    for (const a of ["메모에 따르면 22도입니다.", "팀원이 공유한 메모에 따르면 5장이에요.", "그 내용은 메모에 있어요.", "팀원들이 남긴 의견처럼"]) {
      expect(sourceLeaks(a), a).not.toEqual([]);
    }
    expect(sourceLeaks("팀원이 공유한 메모에 따르면 5장이에요.", "", { memo: true })).toEqual([]);
    expect(sourceLeaks("비공개 메모라 말할 수 없어요.", "", ALL)).not.toEqual([]);
  });
});

describe("답변 정리", () => {
  it("답변의 제어 문자와 글자 방향 조작 문자를 지운다", () => {
    const v = validateChatOutput({ answer: "안전‮한 답\u0007변\u0000입니다⁦.\n둘째 줄", used_refs: [] }, new Set());
    expect(v.answer).toBe("안전한 답변입니다.\n둘째 줄");
  });

  it("실제 낱말인 N1·N2 는 지우지 않고, 내부 번호 흔적만 지운다", () => {
    const refs = new Set(["N1", "N2", "N3"]);
    expect(validateChatOutput({ answer: "JLPT N1급과 N2 교재를 보세요.", used_refs: [] }, refs).answer).toBe("JLPT N1급과 N2 교재를 보세요.");
    expect(validateChatOutput({ answer: "일본어능력시험은 N1, N2, N3 순으로 어려워요.", used_refs: [] }, refs).answer).toBe("일본어능력시험은 N1, N2, N3 순으로 어려워요.");
    expect(validateChatOutput({ answer: "N2는 상급 수준이에요.", used_refs: [] }, refs, "N2 가 어느 정도야?").answer).toBe("N2는 상급 수준이에요.");
    // 내부 번호 흔적은 그대로 지운다
    expect(validateChatOutput({ answer: "온도가 달랐어요 (N1). [N2] 참고", used_refs: ["N1"] }, refs).answer).toBe("온도가 달랐어요 . 참고");
    expect(validateChatOutput({ answer: "N3 에 따르면 금요일이에요.", used_refs: [] }, refs, "리허설 언제야?").answer).toBe("에 따르면 금요일이에요.");
  });

  it("AI 정리문의 제어 문자도 지운다", async () => {
    const s = await setup();
    const n = await createNote(s.alice, s.teamId, { rawText: "발표는 5분" });
    const p = new FakeProvider({ summarize: () => ({ text: "발표는‮ 5분\u0000 안에" }) });
    expect((await summarizeMemos(s.alice, s.teamId, { noteIds: [n.noteId] }, p)).text).toBe("발표는 5분 안에");
  });
});

describe("입력의 제어 문자", () => {
  it("사용자 입력에서 제어 문자와 글자 방향 조작 문자를 지운다 (줄바꿈·탭은 유지)", async () => {
    expect(text("  가\u0000나‮다⁦\u0007\n\t라  ", "값", { max: 100 })).toBe("가나다\n\t라");
    expect(() => text("\u0000‮", "값", { min: 1, max: 100 })).toThrow();
    const alice = await makeUser("alice");
    const team = await createTeam(alice, "A‮팀\u0000");
    expect(team.name).toBe("A팀");
    const m = await createMeeting(alice, team.id, { title: "회‮의", date: "2026-11-06", text: "본\u0000문" });
    const r = await getPool().query("select n.title, v.raw_text from notes n join note_versions v on v.note_id = n.id where n.id = $1", [m.noteId]);
    expect(r.rows[0]).toEqual({ title: "회의", raw_text: "본문" });
  });
});

describe("모델 호출 시간 제한", () => {
  it("한 요청의 모델 호출은 정해진 시간 안에 끝난다 (호출마다 30초가 아니라 요청 전체 기준)", async () => {
    const { withAiBudget, aiBudgetRemainingMs } = await import("../src/lib/ai/timeout.ts");
    const { callAi } = await import("../src/lib/advice.ts");
    const never = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    await withAiBudget(async () => {
      expect(await callAi(async () => { await new Promise((r) => setTimeout(r, 120)); return "ok"; })).toBe("ok");
      expect(aiBudgetRemainingMs()).toBeLessThan(200);
      await expect(callAi(never)).rejects.toMatchObject({ name: "AiTimeout" });
      await expect(callAi(async () => "늦음")).rejects.toMatchObject({ name: "AiTimeout" }); // 시간이 다 됐으면 부르지 않는다
    }, 300);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(aiBudgetRemainingMs()).toBe(Infinity); // 요청 밖에서는 제한 없음
  });

  it("대화: 다시 쓰게 하는 호출이 남은 시간을 넘기면 30초를 기다리지 않고 실패로 끝낸다", async () => {
    const s = await setup();
    const prev = process.env.AI_REQUEST_BUDGET_MS;
    process.env.AI_REQUEST_BUDGET_MS = "1000";
    let calls = 0;
    const slow: AiProvider = {
      ...new FakeProvider(), name: "fake", isAi: true,
      restate: async () => ({}), judge: async () => ({}), advise: async () => ({}), summarize: async () => ({}), recap: async () => ({}), relay: async () => ({ items: [] }),
      chat: (_i, o) => new Promise((resolve, reject) => {
        calls++;
        const t = setTimeout(() => resolve({ answer: "팀원이 공유한 메모에 따르면 5장이에요.", used_refs: [] }), 600); // 출처 규칙 위반 → 다시 쓰게 함
        o?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      }),
    };
    try {
      const started = Date.now();
      const t = await askInProject(s.bob, s.projectId, { question: "슬라이드 몇 장?" }, slow);
      expect(t).toMatchObject({ status: "failed", error: "ai_timeout" });
      expect(calls).toBe(2);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      if (prev === undefined) delete process.env.AI_REQUEST_BUDGET_MS; else process.env.AI_REQUEST_BUDGET_MS = prev;
    }
  });
});

describe("운영 설정과 사용량", () => {
  it("운영에서 AI_PROVIDER=openai 인데 키가 없으면 시작하지 않는다 (개발에서는 경고)", () => {
    const base = { DATABASE_URL: "postgres://x", SESSION_SECRET: "k".repeat(40), AI_PROVIDER: "openai" };
    expect(checkEnvironment({ ...base, NODE_ENV: "production" }).some((p) => p.fatal && p.message.includes("OPENAI_API_KEY"))).toBe(true);
    expect(checkEnvironment({ ...base, VERCEL: "1" }).some((p) => p.fatal)).toBe(true);
    const dev = checkEnvironment({ ...base, NODE_ENV: "development" });
    expect(dev.some((p) => p.message.includes("OPENAI_API_KEY"))).toBe(true);
    expect(dev.every((p) => !p.fatal)).toBe(true);
    expect(checkEnvironment({ ...base, NODE_ENV: "production", OPENAI_API_KEY: "sk" })).toEqual([]);
  });

  it("동시에 온 두 질문의 사용량: 제공자를 함께 쓰면 한쪽에 몰리고, 요청마다 따로 만들면 각자 기록된다", async () => {
    const { OpenAiProvider } = await import("../src/lib/ai/openai.ts");
    const s = await setup();
    // 두 요청의 모델 응답이 같은 순간에 끝나게 한다: 둘 다 모델을 부를 때까지 기다렸다가 함께 응답한다
    const gatedFetch = () => {
      const waiting: (() => void)[] = [];
      return (async () => {
        await new Promise<void>((resolve) => { waiting.push(resolve); if (waiting.length === 2) waiting.forEach((go) => go()); });
        const body = { model: "gpt-test", status: "completed", usage: { input_tokens: 100, output_tokens: 10 },
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ answer: "답변입니다", used_refs: [] }) }] }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
    };
    const ask = async (tag: string, pa: AiProvider, pb: AiProvider) => {
      await Promise.all([
        askInProject(s.alice, s.projectId, { question: `${tag} 질문 A` }, pa),
        askInProject(s.bob, s.projectId, { question: `${tag} 질문 B` }, pb),
      ]);
      const r = await getPool().query(
        "select jsonb_array_length(coalesce(usage->'calls', '[]'::jsonb)) as calls from advice_requests where question like $1 order by question", [`${tag}%`]);
      return r.rows.map((x) => x.calls as number);
    };
    // 예전 방식(제공자 하나를 함께 씀): 먼저 기록하는 쪽이 두 호출을 모두 가져가고 다른 쪽은 0 이 된다
    const fetchShared = gatedFetch();
    const shared = new OpenAiProvider({ apiKey: "sk-test", fetchImpl: fetchShared });
    expect((await ask("공유", shared, shared)).sort()).toEqual([0, 2]);
    // 지금 방식(요청마다 따로): 각자 1회
    const fetchSeparate = gatedFetch();
    const separate = () => new OpenAiProvider({ apiKey: "sk-test", fetchImpl: fetchSeparate });
    expect(await ask("분리", separate(), separate())).toEqual([1, 1]);
  });

  it("OpenAI 제공자는 요청마다 따로 만든다 (동시 요청의 사용량 기록이 섞이지 않게)", () => {
    const a = getProvider({ AI_PROVIDER: "openai" });
    const b = getProvider({ AI_PROVIDER: "openai" });
    expect(a).not.toBe(b);
    expect(a.name).toBe("openai");
  });
});

describe("가입 오류 안내", () => {
  it("초대 코드가 틀리면 무엇이 틀렸는지 알려 준다", async () => {
    await expect(startWithTeam({ displayName: "새 사람", inviteCode: "없는코드" })).rejects.toMatchObject({ status: 404, code: "invite_not_found" });
    const alice = await makeUser("alice");
    await expect(joinTeam(alice, "없는코드")).rejects.toMatchObject({ status: 404, code: "invite_not_found" });
    expect((await getPool().query("select 1 from users")).rowCount).toBe(1); // 가입은 되지 않았다
  });

  it("확실히 거절된 요청과 완료 여부를 모르는 요청을 구분한다", async () => {
    const { ApiError } = await import("../src/app/api-client.ts");
    const { startFailure } = await import("../src/app/start-errors.ts");
    expect(startFailure(new ApiError("초대 코드를 찾을 수 없습니다.", 404, "invite_not_found"))).toEqual({ message: "초대 코드를 찾을 수 없습니다.", uncertain: false, canRecover: false });
    expect(startFailure(new ApiError("이미 시작한 계정입니다.", 409, "registration_already_used"))).toMatchObject({ uncertain: false, canRecover: true });
    expect(startFailure(new ApiError("일시적인 오류", 500, "internal"))).toMatchObject({ uncertain: true, canRecover: true });
    expect(startFailure(new TypeError("Failed to fetch"))).toMatchObject({ uncertain: true, canRecover: true });
  });
});

describe("공유 메모 수정과 메모 저장", () => {
  it("고쳐서 다시 공유가 중간에 실패하면 공유가 풀린 채 남지 않는다", async () => {
    const s = await setup();
    const memo = await shareSummary(s.alice, s.teamId, { text: "슬라이드는 5장 이내" });
    const db = getPool();
    // 새 버전을 현재 버전으로 올리는 순간 실패하게 만든다
    await db.query(`create or replace function test_fail_share() returns trigger as $$ begin
      if new.current_version_id is not null and new.current_version_id is distinct from old.current_version_id then raise exception 'test failure'; end if;
      return new; end $$ language plpgsql`);
    await db.query("create trigger test_fail_share before update on notes for each row execute function test_fail_share()");
    try {
      await expect(reviseShared(s.alice, memo.noteId, { text: "슬라이드는 7장 이내" })).rejects.toThrow();
    } finally {
      await db.query("drop trigger test_fail_share on notes");
      await db.query("drop function test_fail_share()");
    }
    const n = await db.query("select share_state, current_version_id from notes where id = $1", [memo.noteId]);
    expect(n.rows[0]).toEqual({ share_state: "shared", current_version_id: memo.versionId });
    expect((await db.query("select 1 from note_versions where note_id = $1", [memo.noteId])).rowCount).toBe(1);
    // 정상일 때는 새 버전으로 공유된다
    const ok = await reviseShared(s.alice, memo.noteId, { text: "슬라이드는 7장 이내" });
    expect(ok).toMatchObject({ noteId: memo.noteId, shareState: "shared" });
    expect(await aiSees(s.teamId)).toEqual(["슬라이드는 7장 이내"]);
  });

  it("같은 요청 식별자로 메모 저장을 다시 보내면 메모가 하나만 생긴다", async () => {
    const s = await setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const a = await createNote(s.alice, s.teamId, { rawText: "떠오른 생각", clientRequestId: id });
    const b = await createNote(s.alice, s.teamId, { rawText: "떠오른 생각", clientRequestId: id });
    expect(b.noteId).toBe(a.noteId);
    expect(b.versionId).toBe(a.versionId);
    await createNote(s.bob, s.teamId, { rawText: "다른 사람", clientRequestId: id }); // 다른 사람의 같은 식별자는 별개
    await createNote(s.alice, s.teamId, { rawText: "식별자 없이" });
    await createNote(s.alice, s.teamId, { rawText: "식별자 없이" });
    expect((await getPool().query("select 1 from notes")).rowCount).toBe(4);
    await expect(createNote(s.alice, s.teamId, { rawText: "x", clientRequestId: "nope" })).rejects.toMatchObject({ status: 400 });
  });
});
