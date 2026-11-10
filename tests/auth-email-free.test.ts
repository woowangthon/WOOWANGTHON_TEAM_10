import { describe, expect, it } from "vitest";
import { requireMembership } from "../src/lib/access.ts";
import { deleteAccount } from "../src/lib/account.ts";
import { getUser, loginCodeFingerprint, logIn, logInWithCode, prepareLoginCode, rotateLoginCode, signUp, startWithTeam } from "../src/lib/auth.ts";
import { getPool } from "../src/lib/db.ts";
import { listMemos } from "../src/lib/memos.ts";
import { createNote, getNote } from "../src/lib/notes.ts";
import { getInviteCode } from "../src/lib/teams.ts";
import { useCleanDb } from "./helpers.ts";

useCleanDb();

describe("이메일 없는 개인 계정", () => {
  it("코드 사전 발급만으로는 계정·팀·감사 기록을 만들지 않는다", async () => {
    const prepared = prepareLoginCode();
    expect(prepared.loginCode).toMatch(/^MJ(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){8}$/);
    expect(prepared.registrationTicket).toMatch(/^v1\.signup\./);
    const r = await getPool().query("select (select count(*)::int from users) users, (select count(*)::int from teams) teams, (select count(*)::int from audit_log) audit");
    expect(r.rows[0]).toEqual({ users: 0, teams: 0, audit: 0 });
  });

  it("계정 생성 응답을 잃어도 사전에 보관한 코드로 로그인할 수 있다", async () => {
    const prepared = prepareLoginCode();
    // 계정 생성 결과를 사용하지 않고, 생성 전에 받은 코드로만 이어 간다.
    await startWithTeam({ displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket });
    const login = await logInWithCode(prepared.loginCode);
    expect(await getUser(login.userId)).toMatchObject({ display_name: "지우" });
  });

  it("가입 요청을 재시도해도 계정·팀·멤버십이 중복 생성되지 않는다", async () => {
    const prepared = prepareLoginCode();
    const input = { displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket };
    await startWithTeam(input);
    await expect(startWithTeam(input)).rejects.toMatchObject({ status: 409, code: "registration_already_used" });
    const r = await getPool().query("select (select count(*)::int from users) users, (select count(*)::int from teams) teams, (select count(*)::int from memberships) memberships");
    expect(r.rows[0]).toEqual({ users: 1, teams: 1, memberships: 1 });
  });

  it("계정 코드를 바꾼 뒤에도 가입 발급권을 재사용할 수 없다", async () => {
    const prepared = prepareLoginCode();
    const input = { displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket };
    const a = await startWithTeam(input);
    await rotateLoginCode(a.userId, a.loginCode);
    await expect(startWithTeam(input)).rejects.toMatchObject({ status: 409, code: "registration_already_used" });
    expect((await getPool().query("select count(*)::int n from users")).rows[0].n).toBe(1);
    expect((await getPool().query("select count(*)::int n from teams")).rows[0].n).toBe(1);
  });

  it("탈퇴한 계정의 가입 발급권도 만료 전 다시 사용할 수 없다", async () => {
    const prepared = prepareLoginCode();
    const input = { displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket };
    const a = await startWithTeam(input);
    await deleteAccount(a.userId, { loginCode: prepared.loginCode });
    await expect(startWithTeam(input)).rejects.toMatchObject({ status: 409 });
    expect((await getPool().query("select count(*)::int n from users")).rows[0].n).toBe(0);
    expect((await getPool().query("select count(*)::int n from consumed_auth_tickets")).rows[0].n).toBe(1);
  });

  it("동시에 같은 발급권으로 가입해도 한 계정·팀만 생긴다", async () => {
    const prepared = prepareLoginCode();
    const input = { displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket };
    const results = await Promise.allSettled([startWithTeam(input), startWithTeam(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected && rejected.status === "rejected" && rejected.reason).toMatchObject({ status: 409 });
    const r = await getPool().query("select (select count(*)::int from users) users, (select count(*)::int from teams) teams, (select count(*)::int from memberships) memberships, (select count(*)::int from consumed_auth_tickets) consumed");
    expect(r.rows[0]).toEqual({ users: 1, teams: 1, memberships: 1, consumed: 1 });
  });

  it("코드 소모 뒤 팀 생성이 실패하면 소모 기록도 함께 되돌린다", async () => {
    const prepared = prepareLoginCode();
    const input = { displayName: "지우", teamName: "실패 유도", registrationTicket: prepared.registrationTicket };
    // 실제 DB 쓰기 실패를 소모 기록 이후에 일으켜 트랜잭션 경계를 검사한다.
    await getPool().query("alter table teams add constraint auth_test_reject_team check (name <> '실패 유도')");
    try {
      await expect(startWithTeam(input)).rejects.toMatchObject({ code: "23514" });
      expect((await getPool().query("select count(*)::int n from consumed_auth_tickets")).rows[0].n).toBe(0);
      expect((await getPool().query("select count(*)::int n from users")).rows[0].n).toBe(0);
    } finally {
      await getPool().query("alter table teams drop constraint auth_test_reject_team");
    }
    const a = await startWithTeam(input);
    expect((await logInWithCode(prepared.loginCode)).userId).toBe(a.userId);
  });

  it("새 발급권을 소모할 때 만료된 해시만 정리하고 유효한 기록은 남긴다", async () => {
    await getPool().query("insert into consumed_auth_tickets values ($1, $2), ($3, $4)", ["a".repeat(64), new Date(Date.now() - 60_000), "b".repeat(64), new Date(Date.now() + 60_000)]);
    const prepared = prepareLoginCode();
    await startWithTeam({ displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket });
    const hashes = (await getPool().query("select ticket_hash from consumed_auth_tickets")).rows.map((r) => r.ticket_hash);
    expect(hashes).not.toContain("a".repeat(64));
    expect(hashes).toContain("b".repeat(64));
    expect(hashes).toHaveLength(2);
    expect(hashes).not.toContain(prepared.registrationTicket);
    expect(hashes).not.toContain(prepared.loginCode);
  });

  it("만료·변조·다른 목적의 발급권으로 가입할 수 없다", async () => {
    const expired = prepareLoginCode("signup", Date.now() - 31 * 60 * 1000);
    const valid = prepareLoginCode();
    const parts = valid.registrationTicket.split(".");
    parts[2] = String(Number(parts[2]) + 3600);
    const attempts = [expired.registrationTicket, parts.join("."), `${valid.registrationTicket}x`, prepareLoginCode("rotate").registrationTicket, "x".repeat(257), null];
    for (const registrationTicket of attempts) {
      await expect(startWithTeam({ displayName: "지우", teamName: "가상 팀", registrationTicket })).rejects.toMatchObject({ status: 400, code: "invalid_registration_ticket" });
    }
    expect((await getPool().query("select count(*)::int n from users")).rows[0].n).toBe(0);
  });

  it("잘못된 초대를 수정하면 같은 사전 코드로 다시 시작할 수 있다", async () => {
    const prepared = prepareLoginCode();
    await expect(startWithTeam({ displayName: "지우", inviteCode: "없는코드", registrationTicket: prepared.registrationTicket })).rejects.toMatchObject({ status: 404 });
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀", registrationTicket: prepared.registrationTicket });
    expect((await logInWithCode(prepared.loginCode)).userId).toBe(a.userId);
  });

  it("코드 변경 응답을 잃어도 사전에 보관한 새 코드로 이어 간다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    const prepared = prepareLoginCode("rotate");
    await expect(rotateLoginCode(a.userId, a.loginCode, prepareLoginCode().registrationTicket)).rejects.toMatchObject({ status: 400 });
    await expect(rotateLoginCode(a.userId, "잘못된 현재 코드", prepared.registrationTicket)).rejects.toMatchObject({ status: 403 });
    expect((await getPool().query("select count(*)::int n from consumed_auth_tickets")).rows[0].n).toBe(0);
    await rotateLoginCode(a.userId, a.loginCode, prepared.registrationTicket);
    expect((await logInWithCode(prepared.loginCode)).userId).toBe(a.userId);
    await expect(logInWithCode(a.loginCode)).rejects.toMatchObject({ status: 401 });
  });

  it("다른 계정에서 사용한 변경 발급권을 재사용하면 기존 코드가 유지된다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    const b = await startWithTeam({ displayName: "서연", teamName: "다른 팀" });
    const prepared = prepareLoginCode("rotate");
    await rotateLoginCode(a.userId, a.loginCode, prepared.registrationTicket);
    // 현재 해시가 DB에서 사라진 뒤에도 소모 이력으로 재사용을 막는다.
    await rotateLoginCode(a.userId, prepared.loginCode);
    await expect(rotateLoginCode(b.userId, b.loginCode, prepared.registrationTicket)).rejects.toMatchObject({ status: 409 });
    expect((await logInWithCode(b.loginCode)).userId).toBe(b.userId);
  });

  it("이름과 팀 이름으로 계정·팀을 만들고 코드의 해시만 저장한다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    expect(a.loginCode).toMatch(/^MJ(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){8}$/);
    const r = await getPool().query("select email, password_hash, login_code_hash from users where id = $1", [a.userId]);
    expect(r.rows[0]).toEqual({ email: null, password_hash: null, login_code_hash: loginCodeFingerprint(a.loginCode) });
    expect(await getUser(a.userId)).toMatchObject({ display_name: "지우", email: null, auth_method: "code" });
    expect(JSON.stringify(await getUser(a.userId))).not.toContain(a.loginCode);
    expect(await requireMembership(getPool(), a.userId, a.team.id)).toMatchObject({ role: "lead" });
    const audit = await getPool().query("select actor, action, detail from audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain(a.loginCode);
    expect(JSON.stringify(audit.rows)).not.toContain(loginCodeFingerprint(a.loginCode));
  });

  it("같은 이름·팀 이름이어도 개인 계정과 팀은 각각 다르다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "동일 이름" });
    const b = await startWithTeam({ displayName: "지우", teamName: "동일 이름" });
    expect(a.userId).not.toBe(b.userId);
    expect(a.loginCode).not.toBe(b.loginCode);
    expect(a.team.id).not.toBe(b.team.id);
    await expect(requireMembership(getPool(), b.userId, a.team.id)).rejects.toMatchObject({ status: 404 });
  });

  it("초대 코드는 새 팀원만 만들며 다른 사람의 계정에 접속시키지 않는다", async () => {
    const a = await startWithTeam({ displayName: "같은 이름", teamName: "가상 팀" });
    const inviteCode = await getInviteCode(a.userId, a.team.id);
    const b = await startWithTeam({ displayName: "같은 이름", inviteCode });
    expect(b.userId).not.toBe(a.userId);
    expect(b.team.id).toBe(a.team.id);
    expect(await requireMembership(getPool(), b.userId, b.team.id)).toMatchObject({ role: "member" });
    await expect(logInWithCode(inviteCode)).rejects.toMatchObject({ code: "invalid_login" });
    expect((await logInWithCode(b.loginCode)).userId).toBe(b.userId);
    const memo = await createNote(a.userId, a.team.id, { rawText: "지우만 보는 가상 메모" });
    await expect(getNote(b.userId, memo.noteId)).rejects.toMatchObject({ status: 404 });
    expect((await listMemos(b.userId, b.team.id)).mine).toEqual([]);
  });

  it("잘못된 초대로 시작하면 계정·감사 기록도 남기지 않는다", async () => {
    await expect(startWithTeam({ displayName: "지우", inviteCode: "없는초대코드" })).rejects.toMatchObject({ status: 404 });
    const r = await getPool().query("select (select count(*)::int from users) users, (select count(*)::int from teams) teams, (select count(*)::int from memberships) memberships, (select count(*)::int from audit_log) audit");
    expect(r.rows[0]).toEqual({ users: 0, teams: 0, memberships: 0, audit: 0 });
  });

  it("이름과 팀 생성·참여 중 하나가 필요하다", async () => {
    await expect(startWithTeam({ displayName: "", teamName: "팀" })).rejects.toMatchObject({ status: 400 });
    await expect(startWithTeam({ displayName: "지우" })).rejects.toMatchObject({ status: 400 });
    await expect(startWithTeam({ displayName: "지우", teamName: "팀", inviteCode: "초대" })).rejects.toMatchObject({ status: 400 });
    expect((await getPool().query("select count(*)::int n from users")).rows[0].n).toBe(0);
  });

  it("코드를 붙여 넣을 때 소문자·공백·하이픈 차이를 허용한다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    expect((await logInWithCode(a.loginCode.toLowerCase().replaceAll("-", " "))).userId).toBe(a.userId);
    expect((await logInWithCode(a.loginCode.replaceAll("-", ""))).userId).toBe(a.userId);
    await expect(logInWithCode("로그인코드아님")).rejects.toMatchObject({ code: "invalid_login", status: 401 });
    await expect(logInWithCode("MJ-" + "2".repeat(32))).rejects.toMatchObject({ code: "invalid_login", status: 401 });
  });

  it("현재 코드를 확인한 뒤 재발급하며 이전 코드는 사용할 수 없다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    const b = await startWithTeam({ displayName: "다른 사람", teamName: "다른 팀" });
    await expect(rotateLoginCode(a.userId, b.loginCode)).rejects.toMatchObject({ status: 403 });
    await expect(rotateLoginCode(a.userId, undefined)).rejects.toMatchObject({ status: 403 });
    expect((await logInWithCode(a.loginCode)).userId).toBe(a.userId);
    const rotated = await rotateLoginCode(a.userId, a.loginCode);
    expect(rotated.loginCode).not.toBe(a.loginCode);
    await expect(logInWithCode(a.loginCode)).rejects.toMatchObject({ status: 401 });
    await expect(deleteAccount(a.userId, { loginCode: a.loginCode })).rejects.toMatchObject({ status: 403 });
    expect((await logInWithCode(rotated.loginCode)).userId).toBe(a.userId);
  });

  it("탈퇴 때 본인 코드를 재확인하고 마지막 계정과 팀을 지운다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    const b = await startWithTeam({ displayName: "다른 사람", teamName: "다른 팀" });
    await expect(deleteAccount(a.userId, { loginCode: b.loginCode })).rejects.toMatchObject({ code: "wrong_login_code", status: 403 });
    await expect(deleteAccount(a.userId, { password: "anything" })).rejects.toMatchObject({ code: "login_code_required", status: 400 });
    await expect(deleteAccount(a.userId, { loginCode: a.loginCode })).resolves.toMatchObject({ deleted: true, teamsDeleted: 1 });
    expect(await getUser(a.userId)).toBeUndefined();
    await expect(logInWithCode(a.loginCode)).rejects.toMatchObject({ status: 401 });
    expect(await getUser(b.userId)).toBeDefined();
  });

  it("탈퇴해도 다른 팀원과 팀은 남고 팀장만 승계한다", async () => {
    const a = await startWithTeam({ displayName: "지우", teamName: "가상 팀" });
    const b = await startWithTeam({ displayName: "서연", inviteCode: await getInviteCode(a.userId, a.team.id) });
    await deleteAccount(a.userId, { loginCode: a.loginCode });
    expect(await requireMembership(getPool(), b.userId, a.team.id)).toMatchObject({ role: "lead" });
  });

  it("기존 이메일 계정은 원래 비밀번호로 로그인·탈퇴할 수 있다", async () => {
    const password = "correct-horse-battery";
    const a = await signUp({ email: "legacy@example.com", password, displayName: "기존 계정" });
    expect(await getUser(a.userId)).toMatchObject({ email: "legacy@example.com", auth_method: "password" });
    expect((await logIn({ email: "legacy@example.com", password })).userId).toBe(a.userId);
    await expect(rotateLoginCode(a.userId, "anything")).rejects.toMatchObject({ status: 403 });
    await expect(deleteAccount(a.userId, { loginCode: "anything" })).rejects.toMatchObject({ code: "password_required" });
    await expect(deleteAccount(a.userId, { password })).resolves.toMatchObject({ deleted: true });
  });

  it("인증 수단이 없거나 두 가지인 계정 행은 DB에서도 거부한다", async () => {
    await expect(getPool().query("insert into users (display_name) values ('빈 계정')")).rejects.toMatchObject({ code: "23514" });
    await expect(getPool().query("insert into users (display_name, email, password_hash, login_code_hash) values ('겹친 계정', 'x@example.com', 'hash', $1)", ["a".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });
});
