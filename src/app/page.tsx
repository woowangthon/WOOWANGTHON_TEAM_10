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
  return me ? <Teams me={me} /> : <Login onDone={() => location.reload()} />;
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
    <main className="account-layout">
      <aside className="account-sidebar">
        <div className="sidebar-brand">팀 기억 조언자</div>
        <div className="account-intro">
          <p>참고를 허용한 팀의 메모와 회의록을 프로젝트 대화에서 이어 씁니다.</p>
          <ol><li>메모로 남기기</li><li>확인해 공유하기</li><li>프로젝트에서 질문하기</li></ol>
        </div>
      </aside>
      <section className="account-content">
      <form className="auth-form" onSubmit={submit} aria-busy={busy}>
        <h1>{mode === "login" ? "로그인" : "가입"}</h1>
        <p className="muted">{mode === "login" ? "내 팀과 기록을 열어 보세요." : "팀에서 사용할 이름과 계정을 입력해 주세요."}</p>
        {mode === "signup" && (
          <p><label className="field-label" htmlFor="auth-name">이름 · 팀원에게 표시</label><input id="auth-name" aria-label="이름" placeholder="이름" autoComplete="nickname" value={form.displayName} maxLength={40} required disabled={busy}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></p>
        )}
        <p><label className="field-label" htmlFor="auth-email">이메일</label><input id="auth-email" aria-label="이메일" type="email" placeholder="name@example.com" autoComplete="email" value={form.email} required disabled={busy}
          onChange={(e) => setForm({ ...form, email: e.target.value })} /></p>
        <p><label className="field-label" htmlFor="auth-password">비밀번호</label><input id="auth-password" aria-label="비밀번호" aria-describedby="auth-password-help" type="password" value={form.password} minLength={10} required disabled={busy}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onChange={(e) => setForm({ ...form, password: e.target.value })} /><span id="auth-password-help" className="muted">10자 이상</span></p>
        {mode === "signup" && <PrivacyNotice />}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="auth-actions">
          <button className="primary" type="submit" disabled={busy}>{busy ? mode === "login" ? "로그인 중…" : "가입 중…" : mode === "login" ? "로그인" : "가입"}</button>
          <button className="auth-switch" type="button" disabled={busy} onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
            {mode === "login" ? "처음이신가요? 가입" : "로그인으로"}
          </button>
        </div>
      </form>
      </section>
    </main>
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
        <li><b>AI 처리</b>: OpenAI에 보내는 것은 &lsquo;AI로 정리하기&rsquo;를 누른 내 메모, 내 질문과 이어지는 대화(오래된 대화는 요약), 프로젝트 정보, 팀에 공유된 지식과 회의록(AI 참고를 허용한 것), 그리고 &ldquo;내가 할 일&rdquo;을 알아듣도록 <b>질문한 본인의 표시 이름</b>입니다. 이메일·비밀번호와 다른 팀원의 계정 정보는 보내지 않습니다. 다만 메모·회의록 본문에 직접 적은 이름 등은 그대로 전달됩니다. OpenAI 쪽 대화 저장은 끈 상태로 요청합니다.</li>
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
        <li>지워지는 것: 이메일·이름·비밀번호, 내 메모와 내가 공유한 지식 전부(모든 팀), 그 지식을 반영한 AI 답변 내용, 내 대화 기록, 철회해 둔 회의록</li>
        <li>남는 것: 팀에 공유된 회의록(팀 기록). 작성자·고친 사람은 &lsquo;탈퇴한 사용자&rsquo;로 표시됩니다</li>
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
  const [busy, setBusy] = useState(false);
  const load = () => api<Team[]>("/api/teams").then(setTeams, (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError(""); setNotice(""); setBusy(true);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const leave = (t: Team) => {
    if (!confirm(`'${t.name}' 팀에서 나갈까요? 나가면 이 팀의 자료를 볼 수 없습니다. 이미 공유한 메모는 팀에 남습니다.`)) return;
    act(async () => {
      const r = await api<{ promoted: { displayName: string } | null }>(`/api/teams/${t.id}/leave`, { body: {} });
      if (r.promoted) setNotice(`팀장 권한이 ${r.promoted.displayName}님에게 넘어갔습니다.`);
    });
  };
  return (
    <main className="workspace home-workspace">
      <aside className="workspace-sidebar">
        <div className="sidebar-brand">팀 기억 조언자</div>
        <nav className="sidebar-nav" aria-label="계정 메뉴"><a href="#team-list" aria-current="page">내 팀</a><a href="#create-team">새 팀 만들기</a><a href="#join-team">초대 코드로 참여</a><a href="#account-settings">계정</a></nav>
        <MemoFab teams={teams.map((t) => ({ id: t.id, name: t.name }))} />
        <div className="sidebar-account"><p>{me.displayName}</p><button className="small" onClick={() => api("/api/auth/logout", { body: {} }).then(() => location.reload())}>로그아웃</button></div>
      </aside>
      <section className="workspace-list" id="team-list" aria-label="내 팀 목록">
        <div className="pane-header"><h1 className="pane-title">내 팀</h1><p className="pane-subtitle">함께 기록할 팀을 고르세요.</p></div>
        {teams.length === 0 && <p className="pane-subtitle">아직 팀이 없습니다. 팀을 만들거나 초대 코드로 참여하세요.</p>}
        {teams.map((t) => <div className="team-list-entry" key={t.id}><a className="list-item team-list-link" href={`/teams/${t.id}`}><span className="list-item-title">{t.name}</span><span className="list-item-preview">대화 · 메모 · 회의록</span><span className="list-item-meta">{t.role === "lead" ? "팀장" : "팀원"} · {t.member_count}명</span></a><div className="team-list-actions"><button className="small" disabled={busy} onClick={() => leave(t)}>나가기</button></div></div>)}
      </section>
      <section className="workspace-document" aria-label="팀과 계정 관리">
        <header className="document-header"><p className="document-meta">{me.displayName}님의 작업 공간</p><h1 className="document-title">팀과 계정</h1></header>
        <div className="document-body">
          {notice && <p className="okc" role="status">{notice}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <section className="account-section" id="create-team"><h2>새 팀 만들기</h2><form onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) act(() => api("/api/teams", { body: { name } }).then(() => setName(""))); }}><p><label className="field-label" htmlFor="team-name">팀 이름</label><input id="team-name" aria-label="팀 이름" placeholder="팀 이름" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} /></p><button className="primary" type="submit" disabled={!name.trim() || busy}>만들기</button></form></section>
          <section className="account-section" id="join-team"><h2>초대 코드로 참여</h2><form onSubmit={(e) => { e.preventDefault(); if (code.trim() && !busy) act(() => api("/api/teams/join", { body: { inviteCode: code.trim() } }).then(() => setCode(""))); }}><p><label className="field-label" htmlFor="team-invite">초대 코드</label><input id="team-invite" aria-label="초대 코드" placeholder="초대 코드" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} /></p><button type="submit" disabled={!code.trim() || busy}>참여하기</button></form></section>
          <section className="account-section" id="account-settings"><h2>계정</h2><p className="muted">{me.email}</p><DeleteAccount /></section>
        </div>
      </section>
    </main>
  );
}
