"use client";
import { use, useEffect, useState } from "react";
import { restatementWarnings } from "../../../lib/restate-check.ts";
import { api } from "../../api-client.ts";

type Restated = { summary: string; kind: string; conditions: string[]; uncertainties: string[]; clarifying_question: string | null };
type NoteRow = {
  id: string; share_state: "draft" | "shared" | "withdrawn"; is_author: boolean; author_name: string; allow_external_ai: boolean;
  version_id: string; content_hash: string; raw_text: string; restated: Restated | null; intent_state: string; version: number;
};
type AiConfig = { provider: string; available: boolean; fake: boolean };

const KIND_LABEL: Record<string, string> = { proposal: "제안", guess: "추측", question: "질문", objection: "반론" };
type Task = { id: string; title: string; purpose: string; audience: string; constraints: string };

const STATE_LABEL = { draft: "초안 (나만 봄)", shared: "팀에 공유됨", withdrawn: "철회됨" } as const;

export default function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [allowAi, setAllowAi] = useState(true);
  const [task, setTask] = useState({ title: "", purpose: "", audience: "", constraints: "" });
  const [ai, setAi] = useState<AiConfig>({ provider: "none", available: false, fake: false });

  const load = async () => {
    try {
      setNotes(await api(`/api/teams/${teamId}/notes`));
      setTasks(await api(`/api/teams/${teamId}/tasks`));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    load();
    api(`/api/teams/${teamId}/invite`).then((r) => setInvite(r.inviteCode), () => setInvite(null));
    api<{ ai: AiConfig }>("/api/config").then((c) => setAi(c.ai), () => {});
  }, [teamId]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <main>
      <p><a href="/">← 팀 목록</a></p>
      <h1>팀 공간</h1>
      {invite && <p className="muted">초대 코드 (팀장에게만 보임): <code>{invite}</code></p>}
      {ai.fake && <div className="banner">개발용 가짜 응답 모드입니다. 화면의 AI 결과는 실제 AI가 만든 것이 아닙니다.</div>}
      {error && <p className="error">{error}</p>}

      <h2>생각 남기기</h2>
      <div className="card">
        <textarea placeholder="짧게, 미완성이어도 괜찮아요. 예: 두 실험은 측정 조건이 달라 보임. 숫자만 비교하면 오해할 수도"
          value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)} />
        <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
          <label className="check"><input type="checkbox" checked={allowAi} onChange={(e) => setAllowAi(e.target.checked)} />
            AI 정리 허용</label>
          <button className="primary" disabled={!draft.trim()}
            onClick={() => act(() => api(`/api/teams/${teamId}/notes`, { body: { rawText: draft, allowExternalAi: allowAi } }).then(() => setDraft("")))}>
            초안 저장</button>
        </div>
        <p className="muted">초안은 나만 봅니다. 확인 후 &lsquo;공유&rsquo;를 눌러야 팀원에게 보입니다.
          {!ai.available && " 지금은 AI가 연결되지 않아 원문 그대로 등록합니다."}</p>
      </div>

      <h2>메모</h2>
      {notes.length === 0 && <p className="muted">아직 메모가 없습니다.</p>}
      {notes.map((n) => (
        <div className="card" key={n.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">{n.author_name} · v{n.version}</span>
            <span className={`badge ${n.share_state}`}>{STATE_LABEL[n.share_state]}</span>
          </div>
          {n.restated && n.intent_state !== "unconfirmed" && (
            <p style={{ margin: "6px 0 0" }}><strong>{n.restated.summary}</strong>{" "}
              <span className="muted">({KIND_LABEL[n.restated.kind] ?? n.restated.kind} · 작성자 확인)</span></p>
          )}
          {n.is_author && n.share_state !== "shared" && n.intent_state === "unconfirmed" && n.restated
            ? <Compare note={n} act={act} />
            : <pre className="raw">{n.raw_text}</pre>}
          {n.is_author && (
            <div className="row">
              {n.share_state !== "shared" && n.intent_state === "unconfirmed" && !n.restated && (
                <>
                  {n.allow_external_ai && ai.available && (
                    <button onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/restate`, { body: {} }))}>
                      AI로 정리</button>
                  )}
                  <button onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/confirm`, {
                    body: { choice: "raw_only", expectedHash: n.content_hash } }))}>원문 그대로 확인</button>
                  {!n.allow_external_ai && <span className="muted">AI 정리 안 함</span>}
                </>
              )}
              {n.share_state !== "shared" && n.intent_state !== "unconfirmed" && (
                <button className="primary" onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/share`, { body: {} }))}>
                  팀에 공유</button>
              )}
              {n.share_state === "shared" && (
                <button onClick={() => act(() => api(`/api/notes/${n.id}/withdraw`, { body: {} }))}>철회</button>
              )}
              <button className="danger" onClick={() => confirm("삭제하면 되돌릴 수 없습니다. 삭제할까요?") &&
                act(() => api(`/api/notes/${n.id}`, { method: "DELETE" }))}>삭제</button>
            </div>
          )}
        </div>
      ))}

      <h2>작업</h2>
      <div className="card">
        <p><input placeholder="작업 제목 (예: 비전공자 대상 3분 발표 구성)" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} /></p>
        <p><input placeholder="목적" value={task.purpose} onChange={(e) => setTask({ ...task, purpose: e.target.value })} /></p>
        <p><input placeholder="대상" value={task.audience} onChange={(e) => setTask({ ...task, audience: e.target.value })} /></p>
        <p><input placeholder="제약" value={task.constraints} onChange={(e) => setTask({ ...task, constraints: e.target.value })} /></p>
        <button disabled={!task.title.trim()} onClick={() => act(() => api(`/api/teams/${teamId}/tasks`, { body: task })
          .then(() => setTask({ title: "", purpose: "", audience: "", constraints: "" })))}>작업 만들기</button>
      </div>
      {tasks.map((t) => (
        <div className="card" key={t.id}>
          <strong>{t.title}</strong>
          <div className="muted">{[t.purpose, t.audience, t.constraints].filter(Boolean).join(" · ")}</div>
          <p style={{ margin: "6px 0 0" }}><a href={`/teams/${teamId}/tasks/${t.id}`}>팀 기억에서 조언 받기 →</a></p>
        </div>
      ))}
    </main>
  );
}

/** 원문과 AI 정리를 나란히 보여주고 작성자가 의도를 확인한다 (원안 §7.1-5~6). */
function Compare({ note, act }: { note: NoteRow; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const r = note.restated!;
  const warnings = restatementWarnings(note.raw_text, r);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(r.summary);
  const confirm = (choice: "confirmed" | "edited" | "raw_only", editedSummary?: string) =>
    act(() => api(`/api/notes/${note.id}/versions/${note.version_id}/confirm`, {
      body: { choice, expectedHash: note.content_hash, editedSummary } }));
  return (
    <div>
      <div className="compare">
        <div><h3>내가 쓴 원문</h3><pre className="raw">{note.raw_text}</pre></div>
        <div>
          <h3>AI 정리 ({KIND_LABEL[r.kind] ?? r.kind})</h3>
          {editing
            ? <textarea value={summary} maxLength={600} onChange={(e) => setSummary(e.target.value)} />
            : <p style={{ margin: 0 }}>{r.summary}</p>}
          {r.conditions.length > 0 && <><div className="muted">조건</div><ul>{r.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
          {r.uncertainties.length > 0 && <><div className="muted">불확실한 점</div><ul>{r.uncertainties.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
          {r.clarifying_question && <p className="muted">보충 질문: {r.clarifying_question}</p>}
        </div>
      </div>
      {warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}
      <div className="row">
        {editing ? (
          <>
            <button className="primary" disabled={!summary.trim()} onClick={() => confirm("edited", summary)}>고친 내용으로 확인</button>
            <button onClick={() => { setEditing(false); setSummary(r.summary); }}>취소</button>
          </>
        ) : (
          <>
            <button className="primary" onClick={() => confirm("confirmed")}>의도 맞음</button>
            <button onClick={() => setEditing(true)}>직접 고침</button>
            <button onClick={() => confirm("raw_only")}>원문 그대로</button>
          </>
        )}
      </div>
      <p className="muted">공유하고 싶지 않으면 아무것도 누르지 않아도 됩니다. 초안은 나만 봅니다.</p>
    </div>
  );
}
