"use client";
import { useEffect, useState } from "react";
import { api } from "./api-client.ts";
import { MemoFab } from "./memo-fab.tsx";

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
      <p className="muted">AI와 대화하듯 묻고 답하세요. 팀이 메모로 쌓아 둔 생각을 AI가 함께 참고합니다.</p>
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
        {mode === "signup" && <PrivacyNotice />}
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

/** 가입 전에 보여주는 수집·처리 안내. 내용은 docs/보안_점검.md 「개인정보 처리」와 맞춘다. */
function PrivacyNotice() {
  return (
    <details className="notice">
      <summary>가입하면 무엇이 저장되나요?</summary>
      <ul>
        <li><b>수집</b>: 이메일(로그인용), 이름(팀원에게 표시), 비밀번호. 비밀번호는 원문을 저장하지 않고 되돌릴 수 없는 해시로만 저장합니다.</li>
        <li><b>저장 위치</b>: 서비스 데이터베이스(Neon PostgreSQL)와 서버(Vercel). 로그인 상태는 브라우저 쿠키로 7일간 유지됩니다.</li>
        <li><b>AI 처리</b>: OpenAI에 보내는 것은 &lsquo;AI로 정리하기&rsquo;를 누른 내 메모, 내 질문과 이어지는 대화, 프로젝트 정보, 팀에 공유된 지식(AI 참고를 허용한 것)뿐입니다. 이름·이메일은 보내지 않으며, OpenAI 쪽 대화 저장은 끈 상태로 요청합니다.</li>
        <li><b>삭제</b>: 메모와 공유한 지식은 언제든 삭제할 수 있고, 로그인 후 첫 화면의 &lsquo;회원 탈퇴&rsquo;로 계정과 내가 쓴 메모를 모두 지울 수 있습니다.</li>
      </ul>
    </details>
  );
}

function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirm("정말 탈퇴할까요? 되돌릴 수 없습니다.")) return;
    setError(""); setBusy(true);
    try {
      await api("/api/auth/me", { method: "DELETE", body: { password } });
      alert("탈퇴했습니다. 계정과 작성한 메모를 모두 지웠습니다.");
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  if (!open) return <p><button className="small" onClick={() => setOpen(true)}>회원 탈퇴</button></p>;
  return (
    <form className="card" onSubmit={submit}>
      <p><b>회원 탈퇴</b></p>
      <ul className="muted">
        <li>지워지는 것: 이메일·이름·비밀번호, 내 메모와 내가 공유한 지식 전부(모든 팀), 그 지식을 반영한 AI 답변 내용, 내 대화 기록</li>
        <li>팀은 남은 팀원이 계속 씁니다. 내가 유일한 팀장이면 가장 오래된 팀원이 팀장이 되고, 남은 팀원이 없으면 팀 전체를 지웁니다</li>
        <li>내가 만든 프로젝트는 팀에 남고 만든 사람 표시만 지워집니다</li>
      </ul>
      <p><input aria-label="비밀번호 확인" type="password" placeholder="비밀번호 확인" autoComplete="current-password"
        value={password} required onChange={(e) => setPassword(e.target.value)} /></p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="danger" type="submit" disabled={busy || !password}>탈퇴하고 모두 지우기</button>
        <button type="button" onClick={() => { setOpen(false); setPassword(""); setError(""); }}>취소</button>
      </div>
    </form>
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
        <span className="row">
          <MemoFab teams={teams.map((t) => ({ id: t.id, name: t.name }))} />
          <button className="small" onClick={() => api("/api/auth/logout", { body: {} }).then(() => location.reload())}>로그아웃</button>
        </span>
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
      <h2>계정</h2>
      <p className="muted">{me.email}</p>
      <DeleteAccount />
    </>
  );
}
