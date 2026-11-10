"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api-client.ts";
import { MemoFab } from "./memo-fab.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";
import { Login, DeleteAccount, LoginCodeSettings, type AccountMe } from "./account-access.tsx";

type Me = AccountMe;
type Team = { id: string; name: string; role: string; member_count: number };

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false); setMe(undefined);
    // 로그인하지 않은 것(401)만 시작 화면으로 보낸다. 서버 오류나 연결 실패를 "로그인 안 됨"으로 다루면
    // 로그인한 사람에게 시작 화면이 다시 보여, 계정이 사라진 것처럼 보이거나 새 계정을 또 만들게 된다.
    api<Me>("/api/auth/me").then(setMe, (error) => {
      if (error instanceof ApiError && error.status === 401) setMe(null);
      else setFailed(true);
    });
  };
  useEffect(load, []);
  if (failed) return <AccountUnavailable onRetry={load} />;
  if (me === undefined) return <main className="muted">불러오는 중…</main>;
  return me ? <Teams me={me} /> : <Login onDone={() => location.reload()} />;
}

/** 계정 정보를 불러오지 못했을 때. 로그인 상태를 알 수 없으므로 시작 화면 대신 다시 시도하게 한다. */
function AccountUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="account-layout">
      <aside className="account-sidebar"><div className="sidebar-brand">팀 기억 조언자</div></aside>
      <section className="account-content">
        <div className="auth-form">
          <p className="document-meta">팀 기억 조언자</p>
          <h1>지금은 계정 정보를 불러올 수 없습니다</h1>
          <p className="error" role="alert">서버나 연결에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.</p>
          <p className="account-help">로그인 상태와 기록은 그대로일 수 있습니다. 이미 계정이 있다면 새로 시작하지 말고 기다려 주세요.</p>
          <div className="auth-actions"><button className="primary" type="button" onClick={onRetry}>다시 시도</button></div>
        </div>
      </section>
    </main>
  );
}

function Teams({ me }: { me: Me }) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [loadingTeams, setLoadingTeams] = useState(true);
  const [teamsError, setTeamsError] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [completedTeam, setCompletedTeam] = useState<{ id: string; name: string; created: boolean } | null>(null);
  const teamSuccess = useRef<HTMLDivElement>(null);
  const teamRequest = useRef(0);
  const load = async () => {
    const request = ++teamRequest.current;
    setLoadingTeams(true); setTeamsError("");
    try {
      const rows = await api<Team[]>("/api/teams");
      if (request === teamRequest.current) setTeams(rows);
    }
    catch { if (request === teamRequest.current) setTeamsError("팀 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요."); }
    finally { if (request === teamRequest.current) setLoadingTeams(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!completedTeam || loadingTeams) return;
    teamSuccess.current?.focus();
    teamSuccess.current?.scrollIntoView({ block: "nearest" });
  }, [completedTeam, loadingTeams]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(""); setNotice(""); setCompletedTeam(null); setBusy(true);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof TypeError ? "요청을 마치지 못했습니다. 연결을 확인하고 다시 시도해 주세요." : (e as Error).message); }
    finally { setBusy(false); }
  };
  const create = () => act(async () => {
    const team = await api<{ id: string; name: string }>("/api/teams", { body: { name: name.trim() } });
    setName(""); setCompletedTeam({ id: team.id, name: team.name, created: true });
  });
  const join = () => act(async () => {
    const team = await api<{ id: string; name: string }>("/api/teams/join", { body: { inviteCode: code.trim() } });
    setCode(""); setCompletedTeam({ id: team.id, name: team.name, created: false });
  });
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
        <MemoFab teams={(teams ?? []).map((t) => ({ id: t.id, name: t.name }))} />
        <div className="sidebar-account"><p>{me.displayName}</p><ThemeToggle /><button className="small" onClick={() => { if (me.authMethod === "code" && !confirm("개인 로그인 코드를 보관했나요? 다시 들어올 때 필요합니다.")) return; api("/api/auth/logout", { body: {} }).then(() => location.reload()); }}>로그아웃</button></div>
      </aside>
      <section className="workspace-list" id="team-list" aria-label="내 팀 목록" aria-busy={loadingTeams}>
        <div className="pane-header"><h1 className="pane-title">내 팀</h1><p className="pane-subtitle">함께 기록할 팀을 고르세요.</p></div>
        {loadingTeams && <p className="pane-subtitle" role="status">팀 목록을 불러오는 중…</p>}
        {teamsError && <div className="team-list-error"><p className="error" role="alert">{teamsError}</p><button className="small" disabled={loadingTeams || busy} onClick={load}>다시 불러오기</button></div>}
        {!loadingTeams && !teamsError && teams?.length === 0 && <p className="pane-subtitle">아직 팀이 없습니다. 팀을 만들거나 초대 코드로 참여하세요.</p>}
        {teams?.map((t) => <div className="team-list-entry" key={t.id}><a className="list-item team-list-link" href={`/teams/${t.id}`}><span className="list-item-title">{t.name}</span><span className="list-item-preview">대화 · 메모 · 회의록</span><span className="list-item-meta">{t.role === "lead" ? "팀장" : "팀원"} · {t.member_count}명</span></a><div className="team-list-actions"><button className="small" disabled={busy} onClick={() => leave(t)}>나가기</button></div></div>)}
      </section>
      <section className="workspace-document" aria-label="팀과 계정 관리">
        <header className="document-header"><p className="document-meta">{me.displayName}님의 작업 공간</p><h1 className="document-title">팀과 계정</h1></header>
        <div className="document-body">
          {completedTeam && <div ref={teamSuccess} className="team-success" role="status" tabIndex={-1}>
            <p>{completedTeam.name} 팀{completedTeam.created ? "을 만들었습니다." : "에 참여했습니다."}</p>
            <a className="team-open-link" href={`/teams/${completedTeam.id}`}>팀 열기</a>
            {completedTeam.created && <p className="muted">팀을 연 뒤 &lsquo;팀원 초대&rsquo;에서 코드를 복사해 나누세요.</p>}
          </div>}
          {notice && <p className="okc" role="status">{notice}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <section className="account-section" id="create-team"><h2>새 팀 만들기</h2><form onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) create(); }}><p><label className="field-label" htmlFor="team-name">팀 이름</label><input id="team-name" aria-label="팀 이름" placeholder="팀 이름" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} /></p><button className="primary" type="submit" disabled={!name.trim() || busy}>만들기</button></form></section>
          <section className="account-section" id="join-team"><h2>초대 코드로 참여</h2><form onSubmit={(e) => { e.preventDefault(); if (code.trim() && !busy) join(); }}><p><label className="field-label" htmlFor="team-invite">초대 코드</label><input id="team-invite" aria-label="초대 코드" placeholder="초대 코드" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} /></p><button type="submit" disabled={!code.trim() || busy}>참여하기</button></form></section>
          <section className="account-section" id="account-settings"><h2>계정</h2><p className="muted">{me.authMethod === "code" ? "이메일 없이 만든 개인 계정입니다. 개인 로그인 코드는 팀원에게 공유하지 마세요." : me.email}</p>{me.authMethod === "code" && <LoginCodeSettings />}<DeleteAccount authMethod={me.authMethod} /></section>
        </div>
      </section>
    </main>
  );
}
