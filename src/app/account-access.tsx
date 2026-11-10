"use client";
import { useEffect, useState } from "react";
import { api } from "./api-client.ts";

export type AccountMe = { id: string; email: string | null; displayName: string; authMethod: "code" | "password" };
type PreparedCode = { loginCode: string; registrationTicket: string };
const errorMessage = (error: unknown) => error instanceof TypeError
  ? "요청을 마치지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."
  : error instanceof Error ? error.message : "요청을 마치지 못했습니다.";

/** 개인 코드는 React 상태에만 두고 주소·브라우저 저장소에는 쓰지 않는다. */
function CodeReceipt({ code, onContinue, label, busy, error, onBack, onRecover, rotating = false }: { code: string; onContinue: () => void; label: string; busy: boolean; error: string; onBack: () => void; onRecover: () => void; rotating?: boolean }) {
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (saved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setNotice("코드를 복사했습니다. 안전한 곳에 보관해 주세요."); }
    catch { setNotice("복사하지 못했습니다. 아래 코드를 직접 선택하거나 파일로 저장해 주세요."); }
  };
  const download = () => {
    const blob = new Blob([`팀 기억 조언자 — 개인 로그인 코드\n\n${code}\n\n접속 주소: ${location.origin}\n이 코드는 내 계정을 여는 열쇠입니다. 팀원에게 공유하지 마세요.\n팀 초대 코드와 다릅니다. 분실하면 이메일로 복구할 수 없습니다.\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "팀기억-개인로그인코드.txt"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("코드 파일 저장을 요청했습니다. 내려받은 파일을 확인해 주세요.");
  };
  return <section className="login-receipt" aria-labelledby="code-receipt-title">
    <h1 id="code-receipt-title">개인 로그인 코드를 먼저 보관하세요</h1>
    <p>{error ? "완료 여부를 확인하지 못했습니다. 보관한 코드로 계정을 열어 확인할 수 있습니다." : rotating ? "아직 코드를 바꾸지 않았습니다. 새 코드를 보관한 뒤 변경을 완료하세요." : "아직 계정을 만들지 않았습니다. 코드를 보관한 뒤 팀을 열면 시작됩니다."}</p>
    <label className="field-label" htmlFor="issued-login-code">개인 로그인 코드</label>
    <textarea id="issued-login-code" className="access-code" readOnly rows={2} value={code} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
    <div className="access-code-actions"><button type="button" onClick={copy}>코드 복사</button><button type="button" onClick={download}>파일로 저장</button></div>
    {notice && <p className="account-help" role="status">{notice}</p>}
    <p className="account-help">다시 들어올 때 필요한 개인 코드입니다. 팀원에게 보내는 초대 코드가 아닙니다. 화면을 닫으면 다시 표시하지 않으며, 분실하면 계정을 복구할 수 없습니다. 이 기기의 로그인은 7일간 유지됩니다. 30분 안에 다음 단계를 완료해 주세요.</p>
    <p><label><input type="checkbox" checked={saved} disabled={busy} onChange={(e) => setSaved(e.target.checked)} /> 개인 로그인 코드를 보관했습니다</label></p>
    {error && <div><p className="error" role="alert">{error}</p><p className="account-help">응답을 받지 못했어도 완료됐을 수 있습니다. 보관한 코드로 계정을 열어 확인할 수 있습니다.</p><button type="button" disabled={busy} onClick={onRecover}>보관한 코드로 계정 열기</button></div>}
    <div className="access-code-actions"><button className="primary" type="button" disabled={!saved || busy} onClick={onContinue}>{busy ? "처리 중…" : label}</button><button type="button" disabled={busy} onClick={onBack}>이전으로</button></div>
  </section>;
}

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"start" | "login">("start");
  const [teamAction, setTeamAction] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [prepared, setPrepared] = useState<PreparedCode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    setError(""); setBusy(true);
    try {
      if (mode === "login") { await api("/api/auth/login", { body: { loginCode } }); onDone(); }
      else {
        setPrepared(await api<PreparedCode>("/api/auth/prepare", { body: {} }));
      }
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const finishStart = async () => {
    if (!prepared || busy) return; setBusy(true); setError("");
    try {
      const body = { displayName: name, registrationTicket: prepared.registrationTicket, ...(teamAction === "create" ? { teamName } : { inviteCode }) };
      const result = await api<{ team: { id: string } }>("/api/auth/signup", { body });
      location.assign(`/teams/${encodeURIComponent(result.team.id)}`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  const recoverStart = async () => {
    if (!prepared || busy) return; setBusy(true); setError("");
    try { await api("/api/auth/login", { body: { loginCode: prepared.loginCode } }); onDone(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return <main className="account-layout">
    <aside className="account-sidebar">
      <div className="sidebar-brand">팀 기억 조언자</div>
      <div className="account-intro"><p>팀이 남긴 생각을<br />다음 작업으로 이어 갑니다.</p><ol><li>떠오른 생각을 내 메모에 남깁니다.</li><li>팀과 나눌 내용을 확인해 공유합니다.</li><li>프로젝트에서 질문하면 AI가 참고합니다.</li></ol></div>
    </aside>
    <section className="account-content">
      {prepared ? <CodeReceipt code={prepared.loginCode} label={teamAction === "create" ? "보관한 코드로 팀 만들기" : "팀에 참여하고 시작하기"} busy={busy} error={error} onContinue={finishStart} onRecover={recoverStart} onBack={() => { setPrepared(null); setError(""); }} /> : <div className="auth-form">
        <p className="document-meta">팀 기억 조언자</p>
        <h1>함께 쌓아 가는 팀의 기록</h1>
        <p className="account-help">메모와 회의록을 남기고, 프로젝트에서 질문하세요.</p>
        <div className="auth-tabs" aria-label="시작 방법">
          <button type="button" className={mode === "start" ? "on" : ""} aria-pressed={mode === "start"} disabled={busy} onClick={() => { setMode("start"); setError(""); }}>처음 시작하기</button>
          <button type="button" className={mode === "login" ? "on" : ""} aria-pressed={mode === "login"} disabled={busy} onClick={() => { setMode("login"); setError(""); }}>다시 들어가기</button>
        </div>
        <form className="start-form" onSubmit={submit} aria-busy={busy}>
          {mode === "start" ? <>
            <p><label className="field-label" htmlFor="start-name">팀에서 사용할 이름</label><input id="start-name" autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} disabled={busy} /></p>
            <div className="start-options" aria-label="팀 선택"><button type="button" aria-pressed={teamAction === "create"} disabled={busy} onClick={() => { setTeamAction("create"); setError(""); }}>새 팀 만들기</button><button type="button" aria-pressed={teamAction === "join"} disabled={busy} onClick={() => { setTeamAction("join"); setError(""); }}>초대받은 팀 참여</button></div>
            {teamAction === "create" ? <p><label className="field-label" htmlFor="start-team">팀 이름</label><input id="start-team" value={teamName} onChange={(e) => setTeamName(e.target.value)} required maxLength={80} disabled={busy} /></p> : <p><label className="field-label" htmlFor="start-invite">팀 초대 코드</label><input id="start-invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required maxLength={64} autoComplete="off" spellCheck={false} disabled={busy} /></p>}
            <p className="account-help">이메일과 비밀번호는 받지 않습니다. 먼저 개인 로그인 코드를 받아 보관한 뒤 시작합니다. 코드를 분실하면 복구할 수 없습니다.</p>
            <PrivacyNotice />
          </> : <p><label className="field-label" htmlFor="personal-code">개인 로그인 코드</label><input id="personal-code" type="password" autoComplete="off" value={loginCode} onChange={(e) => setLoginCode(e.target.value)} required maxLength={120} disabled={busy} aria-describedby="personal-code-help" /><span className="account-help" id="personal-code-help">시작할 때 보관한 코드를 입력하세요. 팀 초대 코드로는 내 계정에 로그인할 수 없습니다.</span></p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="auth-actions"><button className="primary" type="submit" disabled={busy}>{busy ? "여는 중…" : mode === "login" ? "내 기록 열기" : "개인 로그인 코드 받기"}</button></div>
        </form>
        {mode === "login" && <LegacyLogin onDone={onDone} />}
      </div>}
    </section>
  </main>;
}

function LegacyLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <details className="auth-secondary"><summary>기존 이메일 계정으로 로그인</summary><form onSubmit={async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { await api("/api/auth/login", { body: { email, password } }); onDone(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  }} aria-busy={busy}>
    <p className="account-help">이전에 만든 계정과 기록을 그대로 열 수 있습니다. 새 이메일 계정은 만들지 않습니다.</p>
    <p><label className="field-label" htmlFor="legacy-email">이메일</label><input id="legacy-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy} /></p>
    <p><label className="field-label" htmlFor="legacy-password">비밀번호</label><input id="legacy-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy} /></p>
    {error && <p className="error" role="alert">{error}</p>}<button type="submit" disabled={busy}>{busy ? "로그인 중…" : "기존 계정 열기"}</button>
  </form></details>;
}

function PrivacyNotice() {
  return <details className="notice"><summary>저장하는 정보와 삭제 안내</summary><ul>
    <li>팀에서 사용할 이름, 팀과 기록, 개인 로그인 코드의 해시를 저장합니다. 이메일·비밀번호는 새로 수집하지 않습니다.</li>
    <li>자료는 서비스 데이터베이스(Neon PostgreSQL)와 서버(Vercel)에서 처리합니다. 로그인 쿠키는 7일간 유지됩니다.</li>
    <li>OpenAI에는 AI 정리를 요청한 메모, 질문과 이어지는 대화, 프로젝트 정보, AI 참고를 허용한 공유 지식·회의록과 질문한 본인의 표시 이름을 보냅니다. 개인 로그인 코드는 보내지 않습니다. 본문에 직접 적은 개인정보는 전달될 수 있습니다. OpenAI의 대화 저장을 끈 상태로 요청합니다.</li>
    <li>계정에서 언제든 탈퇴할 수 있습니다. 계정·내 메모·내 대화는 삭제하며, 팀에 공유 중인 회의록은 작성자 표시를 지우고 팀 기록으로 남깁니다.</li>
  </ul></details>;
}

export function DeleteAccount({ authMethod }: { authMethod: AccountMe["authMethod"] }) {
  const [open, setOpen] = useState(false); const [credential, setCredential] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  if (!open) return <p><button type="button" className="small" onClick={() => setOpen(true)}>회원 탈퇴</button></p>;
  const codeAccount = authMethod === "code";
  return <form onSubmit={async (event) => {
    event.preventDefault(); if (busy) return; setError(""); setBusy(true);
    try { await api("/api/auth/me", { method: "DELETE", body: codeAccount ? { loginCode: credential } : { password: credential } }); location.reload(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  }} aria-busy={busy}>
    <h3>회원 탈퇴</h3><p>탈퇴하면 되돌릴 수 없습니다.</p>
    <ul className="account-help"><li>계정과 모든 팀의 내 메모·공유 지식, 내 대화 기록을 지웁니다. 그 지식을 받은 AI 답변의 내용도 지웁니다.</li><li>팀에 공유 중인 회의록은 작성자 표시를 지우고 팀 기록으로 남깁니다.</li><li>팀과 프로젝트는 남은 팀원이 계속 씁니다. 유일한 팀장이면 가장 오래된 팀원에게 넘기고, 남은 팀원이 없으면 팀 전체를 지웁니다.</li></ul>
    <p><label className="field-label" htmlFor="delete-credential">{codeAccount ? "개인 로그인 코드 확인" : "비밀번호 확인"}</label><input id="delete-credential" type="password" autoComplete={codeAccount ? "off" : "current-password"} value={credential} required disabled={busy} onChange={(e) => setCredential(e.target.value)} /></p>
    {error && <p className="error" role="alert">{error}</p>}<div className="row"><button className="danger" type="submit" disabled={busy || !credential.trim()}>{busy ? "삭제 중…" : "탈퇴하고 내 기록 삭제"}</button><button type="button" disabled={busy} onClick={() => { setOpen(false); setCredential(""); setError(""); }}>취소</button></div>
  </form>;
}

export function LoginCodeSettings() {
  const [currentCode, setCurrentCode] = useState(""); const [prepared, setPrepared] = useState<PreparedCode | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const finish = async (recover = false) => {
    if (!prepared || busy) return; setBusy(true); setError("");
    try {
      if (recover) await api("/api/auth/login", { body: { loginCode: prepared.loginCode } });
      else await api("/api/auth/code", { body: { loginCode: currentCode, registrationTicket: prepared.registrationTicket } });
      setPrepared(null); setCurrentCode(""); setNotice("새 코드로 변경했습니다. 보관한 코드를 사용해 주세요.");
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  if (prepared) return <CodeReceipt code={prepared.loginCode} label="보관한 새 코드로 변경하기" rotating busy={busy} error={error} onContinue={() => finish()} onRecover={() => finish(true)} onBack={() => { setPrepared(null); setError(""); }} />;
  return <details className="auth-secondary" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>개인 로그인 코드 바꾸기</summary><form onSubmit={async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { setNotice(""); setPrepared(await api<PreparedCode>("/api/auth/prepare", { body: { purpose: "rotate" } })); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }}><p className="account-help">새 코드를 보관한 뒤 현재 코드를 확인하고 변경합니다. 이전 코드로는 다시 로그인할 수 없습니다. 이미 로그인한 기기는 각 세션이 만료될 때까지 유지됩니다.</p><p><label className="field-label" htmlFor="current-login-code">현재 개인 로그인 코드</label><input id="current-login-code" type="password" autoComplete="off" value={currentCode} onChange={(e) => setCurrentCode(e.target.value)} required disabled={busy} /></p>{error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<button type="submit" disabled={busy}>{busy ? "만드는 중…" : "새 코드 받기"}</button></form></details>;
}
