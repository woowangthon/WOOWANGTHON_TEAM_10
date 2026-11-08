"use client";
// 팀 화면 = 프로젝트 대화. 일반 AI 와 묻고 답하듯 쓰고, AI 는 팀에 공유된 메모를 조용히 참고한다.
import { use, useEffect, useRef, useState } from "react";
import { api } from "../../api-client.ts";
import { AiBanner, TeamHeader, useAiConfig, type TeamInfo } from "../team-header.tsx";

type Project = { id: string; title: string; purpose: string; audience: string; constraints: string; version: number };
type Source = { kind: "memo"; noteId: string; text: string } | { kind: "meeting"; noteId: string; title: string; date: string; text: string };
type Turn = { id: string; question: string; status: string; error: string | null; createdAt: string; answer: string | null; stale: boolean; sources: Source[] };
type ProjectForm = { title: string; purpose: string; audience: string; constraints: string };

const EMPTY_FORM: ProjectForm = { title: "", purpose: "", audience: "", constraints: "" };
const FIELDS = [
  { key: "title", label: "프로젝트 이름", placeholder: "예: LED 식물 실험 결과 발표", max: 200 },
  { key: "purpose", label: "목표", placeholder: "무엇을 이루려고 하나요? 예: 두 실험 결과를 3분 안에 쉽게 설명", max: 1000 },
  { key: "audience", label: "누구를 위한 것인가요", placeholder: "예: 비전공자 심사위원", max: 500 },
  { key: "constraints", label: "마감·조건", placeholder: "예: 11월 15일 18시 제출, 슬라이드 3장", max: 1000 },
] as const;

const ERROR_TEXT: Record<string, string> = {
  ai_timeout: "AI 응답이 늦어 중단했습니다. 다시 물어봐 주세요.",
  ai_error: "AI 호출에 실패했습니다. 다시 물어봐 주세요.",
  invalid_ai_output: "AI 응답 형식이 올바르지 않았습니다. 다시 물어봐 주세요.",
  stale: "처리가 중간에 멈췄습니다. 다시 물어봐 주세요.",
  task_changed: "답하는 사이 프로젝트 정보가 바뀌었습니다. 다시 물어봐 주세요.",
  source_changed: "답변을 마무리하지 못했습니다. 다시 물어봐 주세요.",
  requester_left: "팀을 나가 답변을 저장하지 않았습니다.",
  internal: "일시적인 오류가 발생했습니다.",
};

export default function TeamChatPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const ai = useAiConfig();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "new" | "edit"; value: ProjectForm } | null>(null);
  const [error, setError] = useState("");

  const loadProjects = async (select?: string) => {
    try {
      const rows = await api<Project[]>(`/api/teams/${teamId}/tasks`);
      setProjects(rows);
      const fromUrl = new URLSearchParams(location.search).get("p");
      const pick = select ?? (rows.some((r) => r.id === projectId) ? projectId : null) ?? (rows.some((r) => r.id === fromUrl) ? fromUrl : null) ?? rows[0]?.id ?? null;
      choose(pick);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { loadProjects(); }, [teamId]);

  const choose = (id: string | null) => {
    setProjectId(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set("p", id); else url.searchParams.delete("p");
    history.replaceState(null, "", url);
  };

  const project = projects?.find((p) => p.id === projectId) ?? null;
  const noProjects = projects !== null && projects.length === 0;
  // 화면에 보이는 양식 값 (처음 프로젝트는 아무것도 고치지 않아도 미리 채운 이름으로 만들 수 있어야 한다)
  const editor = form ?? (noProjects ? { mode: "new" as const, value: { ...EMPTY_FORM, title: team ? `${team.name} 프로젝트` : "" } } : null);

  const saveProject = async () => {
    if (!editor) return;
    setError("");
    try {
      if (editor.mode === "new") {
        const p = await api<Project>(`/api/teams/${teamId}/tasks`, { body: editor.value });
        setForm(null);
        await loadProjects(p.id);
      } else if (projectId) {
        await api(`/api/tasks/${projectId}`, { method: "PATCH", body: editor.value });
        setForm(null);
        await loadProjects(projectId);
      }
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <main className="chat-page">
      <TeamHeader teamId={teamId} active="chat" onLoaded={setTeam} />
      <AiBanner ai={ai} />

      {projects && projects.length > 0 && !form && (
        <div className="project-bar">
          <label className="project-pick">
            <span className="muted">프로젝트</span>
            <select aria-label="프로젝트 선택" value={projectId ?? ""} onChange={(e) => choose(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
          <button className="small" onClick={() => setForm({ mode: "new", value: EMPTY_FORM })}>＋ 프로젝트 만들기</button>
        </div>
      )}
      {project && !form && (
        <p className="muted project-info">
          {[project.purpose && `목표: ${project.purpose}`, project.audience && `대상: ${project.audience}`, project.constraints && `마감·조건: ${project.constraints}`]
            .filter(Boolean).join(" · ") || "목표·대상·조건을 적어 두면 AI가 더 맞춤으로 답합니다."}
          {" "}<button className="small" onClick={() => setForm({ mode: "edit", value: { title: project.title, purpose: project.purpose, audience: project.audience, constraints: project.constraints } })}>수정</button>
        </p>
      )}

      {editor && (
        <ProjectEditor
          mode={editor.mode}
          value={editor.value}
          onChange={(value) => setForm({ mode: editor.mode, value })}
          onSave={saveProject}
          onCancel={form && !noProjects ? () => setForm(null) : undefined}
          first={noProjects}
        />
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {project && !form && <Chat key={project.id} project={project} aiReady={ai.available} />}
    </main>
  );
}

function ProjectEditor({ mode, value, onChange, onSave, onCancel, first }: {
  mode: "new" | "edit"; value: ProjectForm; onChange: (v: ProjectForm) => void; onSave: () => void; onCancel?: () => void; first: boolean;
}) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{mode === "new" ? "프로젝트 만들기" : "프로젝트 수정"}</h2>
      {first && <p className="muted">프로젝트는 팀이 함께 만드는 결과물 하나입니다. 적어 둔 목표·대상·조건은 AI가 대화할 때 맥락으로 씁니다. 이름만 적어도 시작할 수 있어요.</p>}
      {FIELDS.map((f) => (
        <p key={f.key}>
          <label className="field-label" htmlFor={`pf-${f.key}`}>{f.label}{f.key === "title" ? "" : " (선택)"}</label>
          <input id={`pf-${f.key}`} placeholder={f.placeholder} value={value[f.key]} maxLength={f.max}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
        </p>
      ))}
      <div className="row">
        <button className="primary" disabled={!value.title.trim()} onClick={onSave}>{mode === "new" ? "만들고 대화 시작" : "저장"}</button>
        {onCancel && <button onClick={onCancel}>취소</button>}
      </div>
    </div>
  );
}

function Chat({ project, aiReady }: { project: Project; aiReady: boolean }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const refreshing = useRef(false);
  const load = () => api<Turn[]>(`/api/tasks/${project.id}/chat`).then(setTurns, (e) => setError((e as Error).message));
  useEffect(() => { load(); }, [project.id]);
  // 다시 써야 하는 답변이 있으면 조용히 다시 쓴다 (화면에는 평범한 '답변 작성 중'으로 보임)
  useEffect(() => {
    const count = turns?.filter((t) => t.stale).length ?? 0;
    if (!count || refreshing.current) return;
    refreshing.current = true;
    api<Turn[]>(`/api/tasks/${project.id}/chat/refresh`, { body: {} })
      .then((next) => { refreshing.current = false; if (next.filter((t) => t.stale).length < count) setTurns(next); else setTurns(next.map((t) => (t.stale ? { ...t, stale: false, status: "failed", error: "ai_error" } : t))); },
        () => { refreshing.current = false; setTurns((prev) => prev?.map((t) => (t.stale ? { ...t, stale: false, status: "failed", error: "ai_error" } : t)) ?? prev); });
  }, [turns, project.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns?.length, pending]);
  // 다른 탭에서 보낸 질문이 아직 처리 중이면 끝날 때까지 다시 읽는다
  useEffect(() => {
    if (!turns?.some((t) => t.status === "pending" && !t.stale) || pending) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [turns, pending]);

  const ask = async () => {
    const q = question.trim();
    if (!q || pending) return;
    setPending(q); setQuestion(""); setError("");
    try {
      const t = await api<Turn>(`/api/tasks/${project.id}/chat`, { body: { question: q, clientRequestId: crypto.randomUUID() } });
      setTurns((prev) => [...(prev ?? []).filter((x) => x.id !== t.id), t]);
    } catch (e) {
      setError((e as Error).message);
      setQuestion(q);
    } finally { setPending(null); }
  };

  return (
    <section className="chat" aria-label="AI 대화">
      <div className="chat-log" aria-live="polite">
        {turns?.length === 0 && !pending && (
          <div className="chat-empty muted">
            <p>프로젝트에 대해 무엇이든 물어보세요. 예:</p>
            <ul>
              <li>발표 첫 장은 어떻게 시작하면 좋을까?</li>
              <li>두 실험 결과를 한 그래프로 비교하려면?</li>
              <li>마감까지 남은 일을 정리해 줘</li>
            </ul>
          </div>
        )}
        {turns?.map((t) => (
          <div key={t.id}>
            <div className="bubble me">{t.question}</div>
            <Answer t={t} />
          </div>
        ))}
        {pending && (
          <div>
            <div className="bubble me">{pending}</div>
            <div className="bubble ai muted">답변 작성 중…</div>
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chat-input">
        <textarea aria-label="질문" rows={2} maxLength={2000} value={question} disabled={!aiReady}
          placeholder={aiReady ? "메시지를 입력하세요 (Enter 보내기, Shift+Enter 줄바꿈)" : "AI가 연결되지 않았습니다"}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(); } }} />
        <button className="primary" disabled={!aiReady || !question.trim() || !!pending} onClick={ask}>보내기</button>
      </div>
      <p className="muted chat-note">AI 답변은 틀릴 수 있습니다. 대화는 나에게만 보입니다.</p>
    </section>
  );
}

function Answer({ t }: { t: Turn }) {
  if (t.status === "pending") return <div className="bubble ai muted">답변 작성 중…</div>;
  if (t.status !== "ok" || !t.answer) return <div className="bubble ai error">{ERROR_TEXT[t.error ?? "internal"] ?? ERROR_TEXT.internal}</div>;
  return (
    <div className="bubble ai">
      {t.answer}
      {t.sources.length > 0 && (
        <details className="sources">
          <summary>참고한 팀 지식 {t.sources.length}개</summary>
          {t.sources.map((s) => <SourceCard key={s.noteId} s={s} />)}
        </details>
      )}
    </div>
  );
}

/** 출처 원문: 길면 앞부분만 보여주고 「전체 보기」로 펼친다 (회의록은 10,000자까지) */
function SourceCard({ s }: { s: Source }) {
  const [full, setFull] = useState(false);
  const long = s.text.length > 400;
  return (
    <div className="source">
      <div className="muted">{s.kind === "meeting" ? `회의록 · ${s.title} (${fmtDay(s.date)})` : "팀원이 공유한 메모"}</div>
      <div className="source-text">{long && !full ? `${s.text.slice(0, 400)}…` : s.text}</div>
      {long && <button className="small link-btn" onClick={() => setFull(!full)}>{full ? "접기" : `전체 보기 (${s.text.length.toLocaleString()}자)`}</button>}
    </div>
  );
}

const fmtDay = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${m}월 ${day}일`;
};
