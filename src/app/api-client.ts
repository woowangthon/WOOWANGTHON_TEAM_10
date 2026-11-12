// 브라우저에서 서버 API 를 부르는 얇은 함수. 비밀값은 여기 두지 않는다.

/** 서버가 오류 응답을 돌려줬을 때 던진다. status 로 "로그인 안 됨(401)"과 "서버 오류(5xx)"를 구분한다. */
export class ApiError extends Error {
  readonly status: number;
  /** 서버가 돌려준 오류 종류 (예: invite_not_found). 응답 본문을 읽지 못했으면 null */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" || (method === "DELETE" && opts.body === undefined) ? undefined : JSON.stringify(opts.body ?? {}),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.message ?? `요청 실패 (${res.status})`, res.status, typeof data.error === "string" ? data.error : null);
  return data as T;
}
