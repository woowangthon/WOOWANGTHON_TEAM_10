// 개인용 로그인 코드. 기존 이메일 + 비밀번호 계정도 계속 로그인할 수 있다.
// - 비밀번호는 scrypt 해시로만 저장한다.
// - 세션은 HMAC 서명된 쿠키(만료 시각 포함). 서명 키는 SESSION_SECRET 환경변수.
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { audit, getPool, withTx, type Db } from "./db.ts";
import { AppError, badRequest, inviteNotFound, notFound, unauthorized } from "./errors.ts";
import { text } from "./validate.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = "mj_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return s;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// 32글자 × 5bit = 160bit. 혼동하기 쉬운 I/O는 빼고, 입력은 공백·하이픈·소문자를 허용한다.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function newLoginCode() {
  const raw = Array.from(randomBytes(32), (b) => CODE_ALPHABET[b & 31]).join("");
  return `MJ-${raw.match(/.{4}/g)!.join("-")}`;
}

function normalizedCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 100) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return /^MJ[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{32}$/.test(code) ? code : null;
}

type CodePurpose = "signup" | "rotate";
const PREPARED_CODE_TTL_SEC = 30 * 60;

function ticketSignature(payload: string): string {
  return createHmac("sha256", secret()).update(`mijuk00:prepared-login-code:v1\0${payload}`).digest("base64url");
}

/** DB에 계정을 만들기 전에 코드를 보관할 수 있도록 서명된 30분짜리 발급권을 돌려준다. */
export function prepareLoginCode(purpose: CodePurpose = "signup", now = Date.now()) {
  if (purpose !== "signup" && purpose !== "rotate") throw badRequest("코드 발급 목적이 올바르지 않습니다.");
  const loginCode = newLoginCode();
  const payload = `v1.${purpose}.${Math.floor(now / 1000) + PREPARED_CODE_TTL_SEC}.${normalizedCode(loginCode)!}`;
  return { loginCode, registrationTicket: `${payload}.${ticketSignature(payload)}` };
}

type PreparedCode = { loginCode: string; ticketHash: string; expiresAt: Date };

function preparedLoginCode(input: unknown, purpose: CodePurpose, now = Date.now()): PreparedCode {
  const invalid = () => new AppError(400, "invalid_registration_ticket", "코드 보관 시간이 지났거나 발급 정보가 올바르지 않습니다. 새 코드를 받아 주세요.");
  if (typeof input !== "string" || input.length > 256) throw invalid();
  const parts = input.split(".");
  if (parts.length !== 5) throw invalid();
  const [version, givenPurpose, expiry, rawCode, signature] = parts as [string, string, string, string, string];
  if (version !== "v1" || givenPurpose !== purpose || !/^\d{10,12}$/.test(expiry)) throw invalid();
  if (Number(expiry) * 1000 <= now || normalizedCode(rawCode) !== rawCode) throw invalid();
  const payload = parts.slice(0, 4).join(".");
  const expected = Buffer.from(ticketSignature(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();
  return {
    loginCode: `MJ-${rawCode.slice(2).match(/.{4}/g)!.join("-")}`,
    ticketHash: createHash("sha256").update(input).digest("hex"),
    expiresAt: new Date(Number(expiry) * 1000),
  };
}

/** 계정 생성·코드 변경과 같은 트랜잭션에서만 호출한다. 실패하면 소모 기록도 취소된다. */
async function consumePreparedCode(tx: Db, prepared: PreparedCode, purpose: CodePurpose) {
  const now = new Date();
  if (prepared.expiresAt <= now) {
    throw new AppError(400, "invalid_registration_ticket", "코드 보관 시간이 지났습니다. 새 코드를 받아 주세요.");
  }
  await tx.query("delete from consumed_auth_tickets where expires_at <= $1", [now]);
  const r = await tx.query(
    "insert into consumed_auth_tickets (ticket_hash, expires_at) values ($1, $2) on conflict do nothing returning ticket_hash",
    [prepared.ticketHash, prepared.expiresAt],
  );
  if (!r.rowCount) {
    throw purpose === "signup"
      ? new AppError(409, "registration_already_used", "이미 사용한 발급 정보입니다. 시작한 계정이 있다면 보관한 개인 로그인 코드로 다시 들어가 주세요.")
      : new AppError(409, "code_already_used", "이미 사용한 코드 발급 정보입니다. 새 코드를 받아 주세요.");
  }
}

/** 요청 제한에도 원문 코드를 남기지 않는다. 잘못된 입력은 같은 빈 값으로 제한한다. */
export function loginCodeFingerprint(input: unknown): string {
  return createHash("sha256").update(normalizedCode(input) ?? "invalid-code").digest("hex");
}

export function verifyLoginCode(input: unknown, stored: string): boolean {
  const code = normalizedCode(input);
  if (!code || !/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(loginCodeFingerprint(code), "hex"), Buffer.from(stored, "hex"));
}

/** 이름은 표시용이다. 같은 이름을 입력해도 각자 다른 개인 계정이 생긴다. */
export async function startWithTeam(input: { displayName: unknown; teamName?: unknown; inviteCode?: unknown; registrationTicket?: unknown }) {
  const name = text(input.displayName, "이름", { min: 1, max: 40 });
  const joining = input.inviteCode !== undefined;
  if (joining && input.teamName !== undefined) throw badRequest("새 팀 이름과 초대 코드 중 하나를 입력해 주세요.");
  const teamInput = joining
    ? text(input.inviteCode, "초대 코드", { min: 1, max: 64 })
    : text(input.teamName, "팀 이름", { min: 1, max: 80 });
  const prepared = input.registrationTicket === undefined ? null : preparedLoginCode(input.registrationTicket, "signup");
  const loginCode = prepared?.loginCode ?? newLoginCode();
  try {
    return await withTx(async (tx) => {
      // 초대 확인부터 계정·멤버십 생성까지 한 번에 성공하거나 전부 취소된다.
      const found = joining ? await tx.query("select id, name from teams where invite_code = $1 for share", [teamInput]) : null;
      if (found && !found.rowCount) throw inviteNotFound();
      if (prepared) await consumePreparedCode(tx, prepared, "signup");
      const u = await tx.query(
        "insert into users (display_name, login_code_hash) values ($1, $2) returning id",
        [name, loginCodeFingerprint(loginCode)],
      );
      const userId = u.rows[0].id as string;
      const team = found?.rows[0] ?? (await tx.query(
        "insert into teams (name, invite_code) values ($1, $2) returning id, name",
        [teamInput, randomBytes(9).toString("base64url")],
      )).rows[0];
      await tx.query("insert into memberships (team_id, user_id, role) values ($1, $2, $3)", [team.id, userId, joining ? "member" : "lead"]);
      await audit(tx, userId, "user.signup", userId);
      await audit(tx, userId, joining ? "team.join" : "team.create", team.id);
      return { userId, loginCode, authMethod: "code" as const, team: { id: team.id as string, name: team.name as string } };
    });
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).code === "23505" && (err as { constraint?: string }).constraint === "users_login_code_hash_key") {
      throw new AppError(409, "registration_already_used", "이미 시작한 계정입니다. 보관한 개인 로그인 코드로 다시 들어가 주세요.");
    }
    throw err;
  }
}

export async function logInWithCode(input: unknown) {
  const code = normalizedCode(input);
  // 잘못된 형식도 같은 조회와 오류를 거친다.
  const r = await getPool().query("select id from users where login_code_hash = $1", [loginCodeFingerprint(code)]);
  if (!code || !r.rowCount) throw new AppError(401, "invalid_login", "로그인 코드가 올바르지 않습니다.");
  const userId = r.rows[0].id as string;
  await audit(getPool(), userId, "user.login", userId);
  return { userId };
}

/** API에서는 사전에 보관한 코드로 바꾼다. 이미 로그인된 기기의 쿠키는 만료까지 유지된다. */
export async function rotateLoginCode(userId: string, input: unknown, registrationTicket?: unknown) {
  const prepared = registrationTicket === undefined ? null : preparedLoginCode(registrationTicket, "rotate");
  const loginCode = prepared?.loginCode ?? newLoginCode();
  try {
    return await withTx(async (tx) => {
      const r = await tx.query("select login_code_hash from users where id = $1 for update", [userId]);
      if (!r.rowCount) throw unauthorized();
      if (!r.rows[0].login_code_hash || !verifyLoginCode(input, r.rows[0].login_code_hash)) {
        throw new AppError(403, "wrong_login_code", "현재 로그인 코드가 올바르지 않습니다.");
      }
      if (prepared) await consumePreparedCode(tx, prepared, "rotate");
      await tx.query("update users set login_code_hash = $2 where id = $1", [userId, loginCodeFingerprint(loginCode)]);
      await audit(tx, userId, "user.rotate_login_code", userId);
      return { loginCode };
    });
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).code === "23505" && (err as { constraint?: string }).constraint === "users_login_code_hash_key") {
      throw new AppError(409, "code_already_used", "이미 사용한 코드입니다. 새 코드를 받아 주세요.");
    }
    throw err;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueSession(userId: string, now = Date.now()): string {
  const payload = `${userId}.${Math.floor(now / 1000) + SESSION_TTL_SEC}`;
  return `${payload}.${sign(payload)}`;
}

/** 쿠키 값을 검증하고 사용자 ID 를 돌려준다. 실패하면 null. */
export function readSession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${userId}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 < now) return null;
  return userId;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SEC,
};

function email(value: unknown): string {
  const e = text(value, "이메일", { min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest("이메일 형식이 올바르지 않습니다.");
  return e;
}

function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 200)
    throw badRequest("비밀번호는 10자 이상이어야 합니다.");
  return value;
}

export async function signUp(input: { email: unknown; password: unknown; displayName: unknown }) {
  const e = email(input.email);
  const pw = password(input.password);
  const name = text(input.displayName, "이름", { min: 1, max: 40 });
  const db = getPool();
  const r = await db.query(
    "insert into users (email, display_name, password_hash) values ($1, $2, $3) on conflict (email) do nothing returning id",
    [e, name, await hashPassword(pw)],
  );
  if (!r.rowCount) throw new AppError(409, "email_taken", "이미 가입된 이메일입니다.");
  await audit(db, r.rows[0].id, "user.signup", r.rows[0].id);
  return { userId: r.rows[0].id as string };
}

export async function logIn(input: { email: unknown; password: unknown }) {
  const e = email(input.email);
  if (typeof input.password !== "string") throw unauthorized();
  const db = getPool();
  const r = await db.query("select id, password_hash from users where email = $1", [e]);
  // 계정이 없어도 같은 시간이 걸리도록 더미 해시를 검증한다 (계정 존재 여부 노출 방지)
  const stored = r.rows[0]?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";
  const ok = await verifyPassword(input.password, stored);
  if (!r.rowCount || !ok) throw new AppError(401, "invalid_login", "이메일 또는 비밀번호가 올바르지 않습니다.");
  await audit(db, r.rows[0].id, "user.login", r.rows[0].id);
  return { userId: r.rows[0].id as string };
}

export async function getUser(userId: string) {
  const r = await getPool().query("select id, email, display_name, case when login_code_hash is not null then 'code' else 'password' end as auth_method from users where id = $1", [userId]);
  return r.rows[0] as { id: string; email: string | null; display_name: string; auth_method: "code" | "password" } | undefined;
}
