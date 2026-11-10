"use client";
import { useEffect, useState } from "react";
import { api } from "../api-client.ts";
import { MemoFab } from "../memo-fab.tsx";
import { ThemeToggle } from "../theme-toggle.tsx";

export type TeamInfo = { id: string; name: string; myRole: string; members: { id: string; displayName: string; role: string; isMe: boolean }[] };
export type AiConfig = { provider: string; available: boolean; fake: boolean };

/** 팀 화면 공통 머리: 팀 이름, 대화 / 메모 보기 전환, 팀 정보(팀원·초대 코드), 로그아웃 */
export function TeamHeader({ teamId, active, onLoaded }: { teamId: string; active: "chat" | "memos" | "meetings"; onLoaded?: (t: TeamInfo) => void }) {
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<TeamInfo>(`/api/teams/${teamId}`).then((t) => {
      setTeam(t);
      onLoaded?.(t);
      // 초대 코드는 팀장에게만 있으므로 팀장일 때만 요청한다
      if (t.myRole === "lead") api(`/api/teams/${teamId}/invite`).then((r) => setInvite(r.inviteCode), () => setInvite(null));
    }, (e) => setError((e as Error).message));
  }, [teamId]);

  const rotateInvite = async () => {
    if (!confirm("초대 코드를 새로 만들까요? 기존 코드는 더 이상 쓸 수 없습니다.")) return;
    try { setInvite((await api<{ inviteCode: string }>(`/api/teams/${teamId}/invite`, { body: {} })).inviteCode); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <header className="team-head workspace-sidebar">
      <a className="sidebar-brand" href="/">팀 기억 조언자</a>
      <div className="sidebar-team"><span className="sidebar-label">현재 팀</span><h1>{team?.name ?? "불러오는 중…"}</h1><a className="sidebar-back" href="/">모든 팀 보기</a></div>
      <div className="sidebar-compose"><MemoFab teamId={teamId} /></div>
      <nav className="tabs" aria-label="팀 메뉴">
        <a href={`/teams/${teamId}`} className={active === "chat" ? "on" : ""} aria-current={active === "chat" ? "page" : undefined}><span className="nav-symbol" aria-hidden="true">◷</span>프로젝트 대화</a>
        <a href={`/teams/${teamId}/memos`} className={active === "memos" ? "on" : ""} aria-current={active === "memos" ? "page" : undefined}><span className="nav-symbol" aria-hidden="true">≡</span>메모 보기</a>
        <a href={`/teams/${teamId}/meetings`} className={active === "meetings" ? "on" : ""} aria-current={active === "meetings" ? "page" : undefined}><span className="nav-symbol" aria-hidden="true">▤</span>회의록</a>
      </nav>
      <div className="sidebar-footer">
      {team && (
        <details className="team-info">
          <summary>팀 정보 · {team.members.length}명</summary>
          <p className="muted">팀원: {team.members.map((m) => `${m.displayName}${m.role === "lead" ? "(팀장)" : ""}${m.isMe ? " ← 나" : ""}`).join(", ")}</p>
          {invite && (
            <p className="muted">초대 코드 (팀장에게만 보임): <code>{invite}</code>{" "}
              <button className="small" onClick={rotateInvite}>재발급</button></p>
          )}
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
  const [ai, setAi] = useState<AiConfig>({ provider: "none", available: false, fake: false });
  useEffect(() => { api<{ ai: AiConfig }>("/api/config").then((c) => setAi(c.ai), () => {}); }, []);
  return ai;
}

export function AiBanner({ ai }: { ai: AiConfig }) {
  if (ai.fake) return <div className="banner preview-banner">개발용 가짜 응답 모드입니다. 화면의 AI 결과는 실제 AI가 만든 것이 아닙니다.</div>;
  if (ai.provider === "misconfigured") return <div className="banner">AI 설정이 잘못되어 AI 기능을 쓸 수 없습니다. 운영자에게 알려 주세요.</div>;
  if (!ai.available) return <div className="banner">AI가 연결되지 않아 대화와 AI 정리를 쓸 수 없습니다. 메모는 쓰고 직접 정리해 공유할 수 있습니다.</div>;
  return null;
}
