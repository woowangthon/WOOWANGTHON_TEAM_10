import { badRequest } from "./errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw badRequest(`${field} 형식이 올바르지 않습니다.`);
  return value.toLowerCase();
}

const INPUT_STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/**
 * 사용자 입력 문자열. 제어 문자(NUL 등)와 글자 방향 조작 문자를 지우고 앞뒤 공백을 뗀다. 줄바꿈과 탭은 남긴다.
 * NUL 은 PostgreSQL 이 받지 않아 500 이 되고, 방향 조작 문자는 화면의 글자 순서를 속이는 데 쓰인다.
 */
export function text(value: unknown, field: string, { min = 0, max }: { min?: number; max: number }): string {
  if (typeof value !== "string") throw badRequest(`${field}는 문자열이어야 합니다.`);
  const v = value.replace(INPUT_STRIP, "").trim();
  if (v.length < min) throw badRequest(`${field}를 입력해 주세요.`);
  if (v.length > max) throw badRequest(`${field}는 ${max}자 이하여야 합니다.`);
  return v;
}

export function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  return text(value, field, { max });
}

export function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw badRequest(`${field}는 true/false 여야 합니다.`);
  return value;
}

/** 제어 문자와 글자 방향을 뒤집는 문자를 지운다 (줄바꿈은 유지). 모델 출력·외부 입력 표시용. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0009\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").trim();
}

/** 글자 단위로 자른다 (한글·이모지가 깨지지 않게). */
export function clip(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join("");
}
