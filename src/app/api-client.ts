// 브라우저에서 서버 API 를 부르는 얇은 함수. 비밀값은 여기 두지 않는다.
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" || (method === "DELETE" && opts.body === undefined) ? undefined : JSON.stringify(opts.body ?? {}),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `요청 실패 (${res.status})`);
  return data as T;
}
