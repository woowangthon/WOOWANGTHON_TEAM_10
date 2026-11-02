import { badRequest } from "./errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw badRequest(`${field} 형식이 올바르지 않습니다.`);
  return value.toLowerCase();
}

export function text(value: unknown, field: string, { min = 0, max }: { min?: number; max: number }): string {
  if (typeof value !== "string") throw badRequest(`${field}는 문자열이어야 합니다.`);
  const v = value.trim();
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
