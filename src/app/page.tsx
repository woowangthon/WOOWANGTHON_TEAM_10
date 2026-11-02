"use client";
import { useEffect, useState } from "react";
import { api } from "./api-client.ts";

type Me = { id: string; email: string; displayName: string };
type Team = { id: string; name: string; role: string };

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe, () => setMe(null));
  }, []);
  if (me === undefined) return <main className="muted">불러오는 중…</main>;
  return <main>{me ? <Teams me={me} /> : <Login onDone={() => location.reload()} />}</main>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [form, setForm] = useState({ email: "", password: "", displayName: "" });
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api(`/api/auth/${mode}`, { body: form });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <h1>팀 기억 조언자</h1>
      <form className="card" onSubmit={submit}>
        {mode === "signup" && (
          <p><input placeholder="이름 (팀원에게 표시됨)" value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></p>
        )}
        <p><input type="email" placeholder="이메일" autoComplete="email" value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })} /></p>
        <p><input type="password" placeholder="비밀번호 (10자 이상)" value={form.password}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onChange={(e) => setForm({ ...form, password: e.target.value })} /></p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" type="submit">{mode === "login" ? "로그인" : "가입"}</button>
          <button type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
            {mode === "login" ? "처음이신가요? 가입" : "로그인으로"}
          </button>
        </div>
      </form>
    </>
  );
}

function Teams({ me }: { me: Me }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const load = () => api<Team[]>("/api/teams").then(setTeams, (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{me.displayName}님의 팀</h1>
        <button onClick={() => api("/api/auth/logout", { body: {} }).then(() => location.reload())}>로그아웃</button>
      </div>
      {teams.length === 0 && <p className="muted">아직 팀이 없습니다. 팀을 만들거나 초대 코드로 가입하세요.</p>}
      {teams.map((t) => (
        <div className="card" key={t.id}>
          <a href={`/teams/${t.id}`}>{t.name}</a> <span className="muted">{t.role === "lead" ? "팀장" : "팀원"}</span>
        </div>
      ))}
      <h2>새 팀</h2>
      <div className="row">
        <input style={{ flex: 1 }} placeholder="팀 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={() => act(() => api("/api/teams", { body: { name } }).then(() => setName("")))}>만들기</button>
      </div>
      <h2>초대 코드로 가입</h2>
      <div className="row">
        <input style={{ flex: 1 }} placeholder="초대 코드" value={code} onChange={(e) => setCode(e.target.value)} />
        <button onClick={() => act(() => api("/api/teams/join", { body: { inviteCode: code } }).then(() => setCode("")))}>가입</button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}
