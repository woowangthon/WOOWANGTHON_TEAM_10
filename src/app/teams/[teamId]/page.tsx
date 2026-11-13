"use client";
// 팀 화면 = 프로젝트 대화. 일반 AI 와 묻고 답하듯 쓰고, AI 는 팀에 공유된 메모를 조용히 참고한다.
import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../api-client.ts";
import { usePanePicker } from "../../pane-picker.ts";
import { AiBanner, TeamHeader, useAiConfig, type AiConfig, type TeamInfo } from "../team-header.tsx";

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
  ai_timeout: "AI 응답이 늦어 중단했습니다. 다시 시도해 주세요.",
  ai_error: "AI 호출에 실패했습니다. 다시 시도해 주세요.",
  invalid_ai_output: "AI 응답 형식이 올바르지 않았습니다. 다시 시도해 주세요.",
  stale: "처리가 중간에 멈췄습니다. 다시 시도해 주세요.",
  task_changed: "답하는 사이 프로젝트 정보가 바뀌었습니다. 다시 시도해 주세요.",
  source_changed: "답변을 마무리하지 못했습니다. 다시 시도해 주세요.",
  requester_left: "팀을 나가 답변을 저장하지 않았습니다.",
  internal: "일시적인 오류가 발생했습니다.",
};

export default function TeamChatPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const router = useRouter();
  const ai = useAiConfig();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "new" | "edit"; value: ProjectForm } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const documentTitle = useRef<HTMLHeadingElement>(null);
  const { picker, closeOnMobile } = usePanePicker();

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
    if (url.href !== location.href) router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };

  const project = projects?.find((p) => p.id === projectId) ?? null;
  const visibleProjects = projects?.filter((p) => p.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [];
  const noProjects = projects !== null && projects.length === 0;
  // 화면에 보이는 양식 값 (처음 프로젝트는 아무것도 고치지 않아도 미리 채운 이름으로 만들 수 있어야 한다)
  const editor = form ?? (noProjects ? { mode: "new" as const, value: { ...EMPTY_FORM, title: team ? `${team.name} 프로젝트` : "" } } : null);

  const saveProject = async () => {
    if (!editor || !editor.value.title.trim() || saving) return;
    setError("");
    setSaving(true);
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
    finally { setSaving(false); }
  };

  return (
    <main className="workspace">
      <TeamHeader teamId={teamId} active="chat" onLoaded={setTeam} />
      <section className="workspace-list" aria-label="프로젝트 목록">
        <details ref={picker} className="pane-picker">
          <summary>프로젝트 목록{project ? ` · ${project.title}` : ""}</summary>
          <div className="pane-items">
            <header className="pane-header">
              <h2 className="pane-title">프로젝트</h2>
              <p className="pane-subtitle">프로젝트마다 나만 보는 대화를 이어갑니다.</p>
              <div className="pane-toolbar">
                <button type="button" onClick={() => { setForm({ mode: "new", value: EMPTY_FORM }); setError(""); closeOnMobile(); }}>새 프로젝트</button>
              </div>
              <label className="project-list-search">
                <span className="field-label">프로젝트 찾기</span>
                <input type="search" value={filter} placeholder="프로젝트 이름" onChange={(e) => setFilter(e.target.value)} />
              </label>
            </header>
            {projects === null && <p className="pane-subtitle" role="status">프로젝트를 불러오는 중…</p>}
            {noProjects && <p className="pane-subtitle">아직 프로젝트가 없습니다. 이름을 적어 첫 대화를 시작하세요.</p>}
            {!!projects?.length && visibleProjects.length === 0 && <p className="pane-subtitle">일치하는 프로젝트가 없습니다.</p>}
            {visibleProjects.map((p) => (
              <a key={p.id} href={`/teams/${teamId}?p=${encodeURIComponent(p.id)}#project-title`} className={`list-item${p.id === projectId && !form ? " selected" : ""}`}
                aria-current={p.id === projectId && !form ? "true" : undefined}
                onClick={(e) => {
                  // 새 탭·새 창으로 여는 클릭은 링크 그대로 둔다. 그 밖에는 화면을 다시 불러오지 않고 프로젝트만 바꾼다.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  if (form && !confirm("프로젝트 정보를 편집 중입니다. 저장하지 않고 이동할까요?")) return;
                  setForm(null); setError("");
                  choose(p.id);
                  closeOnMobile();
                  requestAnimationFrame(() => documentTitle.current?.focus());
                }}>
                <span className="list-item-title">{p.title}</span>
                <span className="list-item-preview">{p.purpose || "목표를 추가할 수 있습니다."}</span>
                {p.constraints && <span className="list-item-meta">{p.constraints}</span>}
              </a>
            ))}
          </div>
        </details>
      </section>
      <section className="workspace-document" aria-label="프로젝트 대화">
        <AiBanner ai={ai} />
        {project && !form && (
          <header className="document-header">
            <div className="pane-toolbar">
              <span className="document-meta">프로젝트 대화 · 나만 봄</span>
              <button type="button" className="small" onClick={() => setForm({ mode: "edit", value: { title: project.title, purpose: project.purpose, audience: project.audience, constraints: project.constraints } })}>프로젝트 수정</button>
            </div>
            <h1 id="project-title" ref={documentTitle} className="document-title" tabIndex={-1}>{project.title}</h1>
            {project.purpose || project.audience || project.constraints ? (
              <dl className="project-context">
                {project.purpose && <div><dt>목표</dt><dd>{project.purpose}</dd></div>}
                {project.audience && <div><dt>대상</dt><dd>{project.audience}</dd></div>}
                {project.constraints && <div><dt>마감·조건</dt><dd>{project.constraints}</dd></div>}
              </dl>
            ) : <p className="document-meta">목표·대상·조건을 적어 두면 AI가 대화할 때 참고합니다.</p>}
          </header>
        )}
        {editor && (
          <ProjectEditor
            mode={editor.mode}
            value={editor.value}
            onChange={(value) => setForm({ mode: editor.mode, value })}
            onSave={saveProject}
            onCancel={form && !noProjects ? () => setForm(null) : undefined}
            first={noProjects}
            saving={saving}
          />
        )}
        {error && <p className="error document-body" role="alert">{error}</p>}
        {projects === null && !error && <p className="document-body muted" role="status">대화를 불러오는 중…</p>}
        {project && !form && <Chat key={project.id} project={project} aiReady={ai.available} aiStatus={ai.status} />}
      </section>
    </main>
  );
}

function ProjectEditor({ mode, value, onChange, onSave, onCancel, first, saving }: {
  mode: "new" | "edit"; value: ProjectForm; onChange: (v: ProjectForm) => void; onSave: () => void; onCancel?: () => void; first: boolean; saving: boolean;
}) {
  return (
    <form className="document-body project-editor" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <h1 className="document-title">{mode === "new" ? "새 프로젝트" : "프로젝트 수정"}</h1>
      {first && <p className="muted">프로젝트는 팀이 함께 만드는 결과물 하나입니다. 적어 둔 목표·대상·조건은 AI가 대화할 때 맥락으로 씁니다. 이름만 적어도 시작할 수 있어요.</p>}
      {FIELDS.map((f) => (
        <p key={f.key}>
          <label className="field-label" htmlFor={`pf-${f.key}`}>{f.label}{f.key === "title" ? "" : " (선택)"}</label>
          <input id={`pf-${f.key}`} placeholder={f.placeholder} value={value[f.key]} maxLength={f.max} required={f.key === "title"} disabled={saving}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
        </p>
      ))}
      <div className="row">
        <button className="primary" type="submit" disabled={!value.title.trim() || saving}>{saving ? "저장 중…" : mode === "new" ? "만들고 대화 시작" : "저장"}</button>
        {onCancel && <button type="button" disabled={saving} onClick={onCancel}>취소</button>}
      </div>
    </form>
  );
}

function Chat({ project, aiReady, aiStatus }: { project: Project; aiReady: boolean; aiStatus: AiConfig["status"] }) {
  type QuestionRequest = { question: string; clientRequestId: string };
  type FailedQuestion = QuestionRequest & { error: string };
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [pending, setPending] = useState<QuestionRequest | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [failedQuestions, setFailedQuestions] = useState<FailedQuestion[]>([]);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const sending = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const questionBox = useRef<HTMLTextAreaElement>(null);

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

  const ask = async (retry?: FailedQuestion) => {
    const q = retry?.question ?? question.trim();
    if (!q || sending.current || !aiReady) return;
    const clientRequestId = retry?.clientRequestId ?? crypto.randomUUID();
    sending.current = true;
    setPending({ question: q, clientRequestId }); setError("");
    if (!retry) setQuestion("");
    try {
      // 응답만 도착하지 않았더라도 같은 식별자로 재시도해 질문을 중복 저장하지 않는다.
      const t = await api<Turn>(`/api/tasks/${project.id}/chat`, { body: { question: q, clientRequestId } });
      setTurns((prev) => [...(prev ?? []).filter((x) => x.id !== t.id), t].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setFailedQuestions((prev) => prev.filter((x) => x.clientRequestId !== clientRequestId));
    } catch (e) {
      const message = e instanceof TypeError
        ? "질문 전송 결과를 확인하지 못했습니다. 연결을 확인한 뒤 다시 보내 주세요."
        : e instanceof Error ? e.message : "질문 전송 결과를 확인하지 못했습니다. 다시 보내 주세요.";
      // 전송을 기다리며 쓴 다음 질문은 입력란에 남기고, 실패한 질문은 별도로 보관한다.
      setFailedQuestions((prev) => [...prev.filter((x) => x.clientRequestId !== clientRequestId), { question: q, clientRequestId, error: message }]);
    } finally { sending.current = false; setPending(null); }
  };

  // 실패한 질문을 같은 자리에서 다시 답하게 한다. 질문을 새로 만들지 않으므로 대화에 같은 질문이 두 번 남지 않는다.
  const retryTurn = async (t: Turn) => {
    if (sending.current || !aiReady) return;
    sending.current = true;
    setRetryingId(t.id); setError("");
    try {
      const next = await api<Turn>(`/api/tasks/${project.id}/chat`, { body: { retry: t.id } });
      setTurns((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev);
    } catch (e) {
      setError(e instanceof TypeError ? "다시 시도한 결과를 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요." : (e as Error).message);
      load(); // 서버에서는 진행됐을 수 있으므로 지금 상태를 다시 읽는다
    } finally { sending.current = false; setRetryingId(null); }
  };

  return (
    <section className="chat document-body" aria-label="AI 대화">
      <div className="chat-log" aria-live="polite">
        {turns === null && !error && <p className="muted" role="status">대화를 불러오는 중…</p>}
        {turns?.length === 0 && !pending && failedQuestions.length === 0 && (
          <div className="chat-empty">
            <h2>첫 질문</h2>
            <p className="muted">프로젝트에 대해 물어보세요. 질문과 답변은 나에게만 보입니다.</p>
            <div className="question-suggestions" aria-label="예시 질문">
              {["발표 준비할 때 놓치기 쉬운 점이 있을까?", "일정을 정할 때 고려할 점이 있을까?", "마감까지 남은 일을 정리해 줘"].map((example) => (
                <button type="button" className="question-example" key={example} disabled={!aiReady}
                  onClick={() => { setQuestion(example); questionBox.current?.focus(); }}><span>{example}</span><span className="example-arrow" aria-hidden="true">↗</span></button>
              ))}
            </div>
          </div>
        )}
        {turns?.map((t) => (
          <article key={t.id} className="chat-turn">
            <div className="chat-speaker">나 <time dateTime={t.createdAt}>{fmtTime(t.createdAt)}</time></div>
            <p className="chat-question">{t.question}</p>
            <Answer t={t} retrying={retryingId === t.id} canRetry={aiReady && !pending && !retryingId} onRetry={() => retryTurn(t)} />
          </article>
        ))}
        {failedQuestions.filter((failed) => failed.clientRequestId !== pending?.clientRequestId).map((failed) => (
          <article key={failed.clientRequestId} className="chat-turn">
            <div className="chat-speaker">전송을 확인하지 못한 질문</div>
            <p className="chat-question">{failed.question}</p>
            <div role="alert">
              <p className="error">{failed.error}</p>
              <button type="button" className="small" disabled={!aiReady || !!pending || !!retryingId} onClick={() => ask(failed)}>다시 보내기</button>
            </div>
          </article>
        ))}
        {pending && (
          <article className="chat-turn">
            <div className="chat-speaker">나</div>
            <p className="chat-question">{pending.question}</p>
            <ChatWaiting />
          </article>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <label className="field-label" htmlFor="chat-question">프로젝트에 질문하기</label>
        <textarea ref={questionBox} id="chat-question" rows={3} maxLength={2000} value={question} disabled={!aiReady}
          aria-describedby="chat-composer-help"
          placeholder={aiStatus === "loading" ? "AI 설정을 확인하는 중…" : aiStatus === "error" ? "AI 설정을 불러오지 못했습니다" : aiReady ? "궁금한 내용을 적어 주세요." : "AI가 연결되지 않았습니다"}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(); } }} />
        <div className="composer-footer">
          <span className="composer-help muted" id="chat-composer-help">Enter 보내기 · Shift+Enter 줄바꿈</span>
          <button className="primary" type="submit" disabled={!aiReady || !question.trim() || !!pending || !!retryingId}>{pending || retryingId ? "답변 작성 중" : "보내기"}</button>
        </div>
      </form>
      <p className="muted chat-note">AI 답변은 틀릴 수 있습니다. 대화는 나에게만 보입니다.</p>
      {/* 스크롤 기준점은 입력창 아래에 둔다. 입력창이 화면 아래에 붙어 있어서, 대화 끝에 두면 새 답변이 입력창 뒤에 가려진다. */}
      <div ref={end} />
    </section>
  );
}

function Answer({ t, retrying, canRetry, onRetry }: { t: Turn; retrying: boolean; canRetry: boolean; onRetry: () => void }) {
  if (t.status === "pending" || retrying) return <ChatWaiting />;
  if (t.status !== "ok" || !t.answer) {
    return (
      <div className="chat-answer" role="alert">
        <p className="error">{ERROR_TEXT[t.error ?? "internal"] ?? ERROR_TEXT.internal}</p>
        <button type="button" className="small" disabled={!canRetry} onClick={onRetry}>다시 시도</button>
      </div>
    );
  }
  return (
    <div className="chat-answer">
      <div className="chat-speaker">AI 답변</div>
      <div className="answer-text">{t.answer}</div>
      {t.sources.length > 0 && (
        <details className="sources">
          <summary>참고한 팀 지식 {t.sources.length}개</summary>
          {t.sources.map((s) => <SourceCard key={s.noteId} s={s} />)}
        </details>
      )}
    </div>
  );
}

/** 처음 답할 때와 기존 답변을 다시 쓸 때 같은 문구를 쓴다. 참고 자료의 존재·변경 사유는 표시하지 않는다. */
function ChatWaiting() {
  return <div className="chat-wait" role="status">답변을 작성하고 있습니다… <span>약 10초가 걸릴 수 있어요.</span></div>;
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

const fmtTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
