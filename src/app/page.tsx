"use client";
import { useEffect, useState } from "react";
import { api } from "./api-client.ts";

type Me = { id: string; email: string; displayName: string };
type Team = { id: string; name: string; role: string; member_count: number };

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
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(`/api/auth/${mode}`, { body: form });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <h1>팀 기억 조언자</h1>
      <p className="muted">팀원이 짧게 남긴 생각을 모아 두고, 작업할 때 관련 생각을 찾아 연결해 줍니다.</p>
      <form className="card" onSubmit={submit}>
        {mode === "signup" && (
          <p><input aria-label="이름" placeholder="이름 (팀원에게 표시됨)" value={form.displayName} maxLength={40} required
            onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></p>
        )}
        <p><input aria-label="이메일" type="email" placeholder="이메일" autoComplete="email" value={form.email} required
          onChange={(e) => setForm({ ...form, email: e.target.value })} /></p>
        <p><input aria-label="비밀번호" type="password" placeholder="비밀번호 (10자 이상)" value={form.password} minLength={10} required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onChange={(e) => setForm({ ...form, password: e.target.value })} /></p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>{mode === "login" ? "로그인" : "가입"}</button>
          <button type="button" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
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
  const [notice, setNotice] = useState("");
  const load = () => api<Team[]>("/api/teams").then(setTeams, (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError(""); setNotice("");
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  const leave = (t: Team) => {
    if (!confirm(`'${t.name}' 팀에서 나갈까요? 나가면 이 팀의 자료를 볼 수 없습니다. 이미 공유한 메모는 팀에 남습니다.`)) return;
    act(async () => {
      const r = await api<{ promoted: { displayName: string } | null }>(`/api/teams/${t.id}/leave`, { body: {} });
      if (r.promoted) setNotice(`팀장 권한이 ${r.promoted.displayName}님에게 넘어갔습니다.`);
    });
  };
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{me.displayName}님의 팀</h1>
        <button onClick={() => api("/api/auth/logout", { body: {} }).then(() => location.reload())}>로그아웃</button>
      </div>
      {teams.length === 0 && <p className="muted">아직 팀이 없습니다. 팀을 만들거나 초대 코드로 가입하세요.</p>}
      {teams.map((t) => (
        <div className="card row" style={{ justifyContent: "space-between" }} key={t.id}>
          <span>
            <a href={`/teams/${t.id}`}>{t.name}</a>{" "}
            <span className="muted">{t.role === "lead" ? "팀장" : "팀원"} · {t.member_count}명</span>
          </span>
          <button className="small" onClick={() => leave(t)}>나가기</button>
        </div>
      ))}
      {notice && <p className="okc">{notice}</p>}
      <h2>새 팀</h2>
      <div className="row">
        <input style={{ flex: 1 }} aria-label="팀 이름" placeholder="팀 이름" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={() => act(() => api("/api/teams", { body: { name } }).then(() => setName("")))}>만들기</button>
      </div>
      <h2>초대 코드로 가입</h2>
      <div className="row">
        <input style={{ flex: 1 }} aria-label="초대 코드" placeholder="초대 코드" value={code} onChange={(e) => setCode(e.target.value)} />
        <button disabled={!code.trim()} onClick={() => act(() => api("/api/teams/join", { body: { inviteCode: code.trim() } }).then(() => setCode("")))}>가입</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
