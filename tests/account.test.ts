import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/lib/account.ts";
import { reactToItem, requestAdvice } from "../src/lib/advice.ts";
import { noAiProvider } from "../src/lib/ai/providers.ts";
import { logIn, signUp } from "../src/lib/auth.ts";
import { getPool } from "../src/lib/db.ts";
import { confirmVersion, createNote, shareNote } from "../src/lib/notes.ts";
import { createTask, getTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam, leaveTeam, listMyTeams, getTeam } from "../src/lib/teams.ts";
import { makeUser, useCleanDb } from "./helpers.ts";

useCleanDb();

const PW = "correct-horse-battery";
const EXP = "두 실험은 측정 조건이 달라 보임. 숫자만 비교하면 오해할 수도";

async function share(userId: string, teamId: string, raw: string) {
  const n = await createNote(userId, teamId, { rawText: raw });
  await confirmVersion(userId, n.noteId, n.versionId, { choice: "raw_only", expectedHash: n.contentHash });
  await shareNote(userId, n.noteId, n.versionId);
  return n;
}

const count = async (sql: string, params: unknown[] = []) =>
  (await getPool().query(`select count(*)::int as c from ${sql}`, params)).rows[0].c as number;

/** alice(팀장)가 메모를 공유하고, bob 이 그 메모를 근거로 조언을 받은 상태 */
async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  const note = await share(alice, team.id, EXP);
  const aliceTask = await createTask(alice, team.id, { title: "실험 결과 발표 준비", purpose: "측정 조건 설명" });
  const bobTask = await createTask(bob, team.id, { title: "실험 숫자 비교 슬라이드", purpose: "측정 조건 정리" });
  const advice = await requestAdvice(bob, bobTask.id, {}, noAiProvider);
  return { alice, bob, teamId: team.id, note, aliceTaskId: aliceTask.id as string, bobTaskId: bobTask.id as string, advice };
}

describe("회원 탈퇴", () => {
  it("비밀번호가 틀리면 아무것도 지우지 않는다", async () => {
    const s = await setup();
    const err = await deleteAccount(s.alice, { password: "wrong-password!!" }).catch((e) => e);
    expect(err.code).toBe("wrong_password");
    const missing = await deleteAccount(s.alice, { password: "" }).catch((e) => e);
    expect(missing.code).toBe("password_required");
    expect(await count("users where id = $1", [s.alice])).toBe(1);
    expect(await count("notes where author_id = $1", [s.alice])).toBe(1);
  });

  it("이메일·이름·비밀번호 해시와 작성한 메모(모든 버전)를 지운다", async () => {
    const s = await setup();
    const r = await deleteAccount(s.alice, { password: PW });
    expect(r).toMatchObject({ deleted: true, notesDeleted: 1, teamsDeleted: 0 });
    expect(await count("users where id = $1", [s.alice])).toBe(0);
    expect(await count("users where email like 'alice%'")).toBe(0);
    expect(await count("notes where author_id = $1", [s.alice])).toBe(0);
    expect(await count("note_versions where note_id = $1", [s.note.noteId])).toBe(0);
    // 같은 이메일로는 로그인할 수 없다
    const err = await logIn({ email: "alice1@example.com", password: PW }).catch((e) => e);
    expect(err.code).toBe("invalid_login");
  });

  it("탈퇴자의 메모를 근거로 쓴 다른 사람의 조언은 무효화되고 본문·인용이 지워진다", async () => {
    const s = await setup();
    expect(s.advice.items.length).toBeGreaterThan(0);
    await deleteAccount(s.alice, { password: PW });
    const req = await getPool().query("select status from advice_requests where id = $1", [s.advice.id]);
    expect(req.rows[0].status).toBe("invalidated");
    const items = await getPool().query("select body, quotes::text as q, purged from advice_items where request_id = $1", [s.advice.id]);
    for (const it of items.rows) {
      expect(it.purged).toBe(true);
      expect(it.body).toBe("");
      expect(it.q).not.toContain("측정");
    }
  });

  it("탈퇴자 본인의 조언 요청·조언·반응을 지운다", async () => {
    const s = await setup();
    const item = s.advice.items[0]!;
    await reactToItem(s.bob, item.id, { reaction: "apply" });
    expect(await count("reactions where user_id = $1", [s.bob])).toBe(1);
    await deleteAccount(s.bob, { password: PW });
    expect(await count("reactions where user_id = $1", [s.bob])).toBe(0);
    expect(await count("advice_requests where requester_id = $1", [s.bob])).toBe(0);
    expect(await count("advice_items where request_id = $1", [s.advice.id])).toBe(0);
  });

  it("팀과 작업은 남은 팀원에게 남고, 만든 사람 표시만 비운다. 유일한 팀장이면 팀장을 넘긴다", async () => {
    const s = await setup();
    await deleteAccount(s.alice, { password: PW });
    const teams = await listMyTeams(s.bob);
    expect(teams).toEqual([expect.objectContaining({ id: s.teamId, role: "lead", member_count: 1 })]);
    const task = await getTask(s.bob, s.aliceTaskId);
    expect(task.title).toBe("실험 결과 발표 준비");
    const row = await getPool().query("select created_by from tasks where id = $1", [s.aliceTaskId]);
    expect(row.rows[0].created_by).toBeNull();
    const overview = await getTeam(s.bob, s.teamId);
    expect(overview.members.map((m) => m.displayName)).toEqual(["bob"]);
  });

  it("활동 중인 팀원이 남지 않는 팀은 통째로 지운다 (이미 나간 사람의 공유 메모 포함)", async () => {
    const s = await setup();
    await leaveTeam(s.bob, s.teamId);
    const r = await deleteAccount(s.alice, { password: PW });
    expect(r.teamsDeleted).toBe(1);
    expect(await count("teams where id = $1", [s.teamId])).toBe(0);
    expect(await count("tasks where team_id = $1", [s.teamId])).toBe(0);
    expect(await count("notes where team_id = $1", [s.teamId])).toBe(0);
    // bob 계정은 그대로
    expect(await count("users where id = $1", [s.bob])).toBe(1);
  });

  it("이미 나간 팀에 남겨 둔 메모도 지운다", async () => {
    const s = await setup();
    const other = await makeUser("carol");
    const team2 = await createTeam(other, "B팀");
    await joinTeam(s.alice, team2.inviteCode);
    await share(s.alice, team2.id, "B팀에 남긴 생각");
    await leaveTeam(s.alice, team2.id);
    const r = await deleteAccount(s.alice, { password: PW });
    expect(r.notesDeleted).toBe(2);
    expect(await count("notes where team_id = $1", [team2.id])).toBe(0);
    expect(await count("teams where id = $1", [team2.id])).toBe(1); // carol 이 남아 있다
  });

  it("감사 로그에는 ID 와 개수만 남고 이메일·이름·본문은 남지 않는다", async () => {
    const s = await setup();
    await deleteAccount(s.alice, { password: PW });
    const log = await getPool().query("select action, detail::text as d from audit_log where action = 'user.delete'");
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].d).not.toMatch(/alice|example\.com|측정/);
    const all = await getPool().query("select coalesce(string_agg(detail::text, ' '), '') as d from audit_log");
    expect(all.rows[0].d).not.toMatch(/alice1@example\.com|측정 조건/);
  });

  it("탈퇴한 뒤 같은 이메일로 다시 가입할 수 있다", async () => {
    const s = await setup();
    await deleteAccount(s.alice, { password: PW });
    const again = await signUp({ email: "alice1@example.com", password: PW, displayName: "alice" });
    expect(again.userId).not.toBe(s.alice);
  });
});
