"use client";
import { use, useEffect, useState } from "react";
import { api } from "../../api-client.ts";

type NoteRow = {
  id: string; share_state: "draft" | "shared" | "withdrawn"; is_author: boolean; author_name: string;
  version_id: string; content_hash: string; raw_text: string; intent_state: string; version: number;
};
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

  const load = async () => {
    try {
      setNotes(await api(`/api/teams/${teamId}/notes`));
      setTasks(await api(`/api/teams/${teamId}/tasks`));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    load();
    api(`/api/teams/${teamId}/invite`).then((r) => setInvite(r.inviteCode), () => setInvite(null));
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
        <p className="muted">초안은 나만 봅니다. 확인 후 &lsquo;공유&rsquo;를 눌러야 팀원에게 보입니다. (AI 정리 기능은 다음 단계에서 추가)</p>
      </div>

      <h2>메모</h2>
      {notes.length === 0 && <p className="muted">아직 메모가 없습니다.</p>}
      {notes.map((n) => (
        <div className="card" key={n.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">{n.author_name} · v{n.version}</span>
            <span className={`badge ${n.share_state}`}>{STATE_LABEL[n.share_state]}</span>
          </div>
          <pre className="raw">{n.raw_text}</pre>
          {n.is_author && (
            <div className="row">
              {n.share_state !== "shared" && n.intent_state === "unconfirmed" && (
                <button onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/confirm`, {
                  body: { choice: "raw_only", expectedHash: n.content_hash } }))}>원문 그대로 확인</button>
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
          <p className="muted">조언 요청은 다음 단계에서 추가됩니다.</p>
        </div>
      ))}
    </main>
  );
}
