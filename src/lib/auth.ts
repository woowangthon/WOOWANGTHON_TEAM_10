// 이메일 + 비밀번호 로그인 (외부 패키지 없이 Node 내장 crypto 사용).
// - 비밀번호는 scrypt 해시로만 저장한다.
// - 세션은 HMAC 서명된 쿠키(만료 시각 포함). 서명 키는 SESSION_SECRET 환경변수.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { audit, getPool } from "./db.ts";
import { AppError, badRequest, unauthorized } from "./errors.ts";
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
  const r = await getPool().query("select id, email, display_name from users where id = $1", [userId]);
  return r.rows[0] as { id: string; email: string; display_name: string } | undefined;
}
