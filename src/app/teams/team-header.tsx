"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "../api-client.ts";
import { MemoFab } from "../memo-fab.tsx";
import { ThemeToggle } from "../theme-toggle.tsx";

export type TeamInfo = { id: string; name: string; myRole: string; members: { id: string; displayName: string; role: string; isMe: boolean }[] };
export type AiConfig = { provider: string; available: boolean; fake: boolean; status: "loading" | "ready" | "error" };

/** 팀 화면 공통 머리: 팀 이름, 대화 / 메모 보기 전환, 팀 정보(팀원·초대 코드), 로그아웃 */
export function TeamHeader({ teamId, active, onLoaded }: { teamId: string; active: "chat" | "memos" | "meetings"; onLoaded?: (t: TeamInfo) => void }) {
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<"loading" | "ready" | "error">("loading");
  const [copyNotice, setCopyNotice] = useState("");
  const [error, setError] = useState("");
  const teamDetails = useRef<HTMLDetailsElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const inviteOperation = useRef(0);

  useEffect(() => {
    let current = true;
    const operation = ++inviteOperation.current;
    setTeam(null); setInvite(null); setCopyNotice(""); setError(""); setInviteStatus("loading");
    api<TeamInfo>(`/api/teams/${teamId}`).then((t) => {
      if (!current) return;
      setTeam(t);
      onLoaded?.(t);
      // 초대 코드는 팀장에게만 있으므로 팀장일 때만 요청한다
      if (t.myRole === "lead") api<{ inviteCode: string }>(`/api/teams/${teamId}/invite`).then((r) => {
        if (current && operation === inviteOperation.current) { setInvite(r.inviteCode); setInviteStatus("ready"); }
      }, () => { if (current && operation === inviteOperation.current) setInviteStatus("error"); });
    }, (e) => { if (current) setError((e as Error).message); });
    return () => { current = false; };
  }, [teamId]);

  const openInvite = () => {
    if (teamDetails.current) teamDetails.current.open = true;
    requestAnimationFrame(() => {
      teamDetails.current?.scrollIntoView({ block: "nearest" });
      copyButton.current?.focus({ preventScroll: true });
    });
  };

  const copyInvite = async () => {
    if (!invite || inviteStatus !== "ready") return;
    const operation = inviteOperation.current;
    try { await navigator.clipboard.writeText(invite); if (operation === inviteOperation.current) setCopyNotice("초대 코드를 복사했습니다. 팀원에게 전달해 주세요."); }
    catch { if (operation === inviteOperation.current) setCopyNotice("복사하지 못했습니다. 코드를 직접 선택해 복사해 주세요."); }
  };

  const reloadInvite = async () => {
    if (team?.myRole !== "lead") return;
    const operation = ++inviteOperation.current;
    setInviteStatus("loading"); setCopyNotice("");
    try { const r = await api<{ inviteCode: string }>(`/api/teams/${teamId}/invite`); if (operation === inviteOperation.current) { setInvite(r.inviteCode); setInviteStatus("ready"); } }
    catch { if (operation === inviteOperation.current) setInviteStatus("error"); }
  };

  const rotateInvite = async () => {
    if (inviteStatus === "loading") return;
    if (!confirm("초대 코드를 새로 만들까요? 기존 코드는 더 이상 쓸 수 없습니다.")) return;
    const operation = ++inviteOperation.current;
    setInviteStatus("loading"); setCopyNotice("");
    try { const r = await api<{ inviteCode: string }>(`/api/teams/${teamId}/invite`, { body: {} }); if (operation === inviteOperation.current) { setInvite(r.inviteCode); setInviteStatus("ready"); } }
    catch { if (operation === inviteOperation.current) setInviteStatus("error"); }
  };

  return (
    <header className="team-head workspace-sidebar">
      <a className="sidebar-brand" href="/">넌지시</a>
      <div className="sidebar-team"><span className="sidebar-label">현재 팀</span><h1>{team?.name ?? "불러오는 중…"}</h1><a className="sidebar-back" href="/">모든 팀 보기</a></div>
      <div className="sidebar-compose"><MemoFab teamId={teamId} />{team?.myRole === "lead" && <button className="invite-trigger" type="button" onClick={openInvite}>팀원 초대</button>}</div>
      <nav className="tabs" aria-label="팀 메뉴">
        <a href={`/teams/${teamId}`} className={active === "chat" ? "on" : ""} aria-current={active === "chat" ? "page" : undefined}><span className="nav-symbol" aria-hidden="true">◷</span>프로젝트 대화</a>
        <a href={`/teams/${teamId}/memos`} className={active === "memos" ? "on" : ""} aria-current={active === "memos" ? "page" : undefined}><span className="nav-symbol" aria-hidden="true">≡</span>메모 보기</a>
        <a href={`/teams/${teamId}/meetings`} className={active === "meetings" ? "on" : ""} aria-current={active === "meetings" ? "page" : undefined}><span className="nav-symbol" aria-hidden="true">▤</span>회의록</a>
      </nav>
      <div className="sidebar-footer">
      {team && (
        <details ref={teamDetails} className="team-info">
          <summary>팀원{team.myRole === "lead" ? "·초대" : ""} · {team.members.length}명</summary>
          <p className="muted">팀원: {team.members.map((m) => `${m.displayName}${m.role === "lead" ? "(팀장)" : ""}${m.isMe ? " ← 나" : ""}`).join(", ")}</p>
          {team.myRole === "lead" && <div className="team-invite">
            <p className="muted">초대 코드 · 팀장에게만 표시됩니다.</p>
            {invite && <code className="invite-code">{invite}</code>}
            {inviteStatus === "loading" && <p role="status">초대 코드를 불러오는 중…</p>}
            {inviteStatus === "error" && <p role="alert">초대 코드를 불러오지 못했습니다. <button className="small" onClick={reloadInvite}>다시 불러오기</button></p>}
            <div className="row"><button ref={copyButton} className="small" disabled={!invite || inviteStatus !== "ready"} onClick={copyInvite}>초대 코드 복사</button><button className="small" disabled={inviteStatus !== "ready"} onClick={rotateInvite}>코드 재발급</button></div>
            {copyNotice && <p role="status">{copyNotice}</p>}
          </div>}
        </details>
      )}
      <ThemeToggle />
      <button className="sidebar-logout" onClick={() => api("/api/auth/logout", { body: {} }).then(() => (location.href = "/"))}>로그아웃</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </header>
  );
}

export function useAiConfig() {
  const [ai, setAi] = useState<AiConfig>({ provider: "none", available: false, fake: false, status: "loading" });
  useEffect(() => {
    let current = true;
    api<{ ai: Omit<AiConfig, "status"> }>("/api/config").then((c) => {
      if (current) setAi({ ...c.ai, status: "ready" });
    }, () => { if (current) setAi({ provider: "none", available: false, fake: false, status: "error" }); });
    return () => { current = false; };
  }, []);
  return ai;
}

export function AiBanner({ ai }: { ai: AiConfig }) {
  if (ai.status === "loading") return <div className="banner loading-notice" role="status">AI 설정을 확인하는 중…</div>;
  if (ai.status === "error") return <div className="banner" role="alert">AI 설정을 불러오지 못했습니다. 잠시 후 화면을 새로고침해 주세요.</div>;
  if (ai.fake) return <div className="banner preview-banner">개발용 가짜 응답 모드입니다. 화면의 AI 결과는 실제 AI가 만든 것이 아닙니다.</div>;
  if (ai.provider === "misconfigured") return <div className="banner">AI 설정이 잘못되어 AI 기능을 쓸 수 없습니다. 운영자에게 알려 주세요.</div>;
  if (!ai.available) return <div className="banner">AI가 연결되지 않아 대화와 AI 정리를 쓸 수 없습니다. 메모는 쓰고 직접 정리해 공유할 수 있습니다.</div>;
  return null;
}
