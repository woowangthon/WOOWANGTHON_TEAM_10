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
type Task = { id: string; title: string; purpose: string; audience: string; constraints: string };
type TeamInfo = { id: string; name: string; myRole: string; members: { id: string; displayName: string; role: string; isMe: boolean }[] };

const KIND_LABEL: Record<string, string> = { proposal: "제안", guess: "추측", question: "질문", objection: "반론" };
const STATE_LABEL = { draft: "초안 (나만 봄)", shared: "팀에 공유됨", withdrawn: "철회됨" } as const;

export default function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
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
    api<TeamInfo>(`/api/teams/${teamId}`).then((t) => {
      setTeam(t);
      // 초대 코드는 팀장에게만 있으므로 팀장일 때만 요청한다
      if (t.myRole === "lead") api(`/api/teams/${teamId}/invite`).then((r) => setInvite(r.inviteCode), () => setInvite(null));
    }, (e) => setError((e as Error).message));
    load();
    api<{ ai: AiConfig }>("/api/config").then((c) => setAi(c.ai), () => {});
  }, [teamId]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  const rotateInvite = async () => {
    if (!confirm("초대 코드를 새로 만들까요? 기존 코드는 더 이상 쓸 수 없습니다.")) return;
    try { setInvite((await api<{ inviteCode: string }>(`/api/teams/${teamId}/invite`, { body: {} })).inviteCode); }
    catch (e) { setError((e as Error).message); }
  };

  if (error && !team) return <main><p><a href="/">← 팀 목록</a></p><p className="error" role="alert">{error}</p></main>;

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <a href="/">← 팀 목록</a>
        <button className="small" onClick={() => api("/api/auth/logout", { body: {} }).then(() => (location.href = "/"))}>로그아웃</button>
      </div>
      <h1>{team?.name ?? "팀 공간"}</h1>
      {team && (
        <p className="muted">팀원: {team.members.map((m) => `${m.displayName}${m.role === "lead" ? "(팀장)" : ""}${m.isMe ? " ← 나" : ""}`).join(", ")}</p>
      )}
      {invite && (
        <p className="muted">초대 코드 (팀장에게만 보임): <code>{invite}</code>{" "}
          <button className="small" onClick={rotateInvite}>재발급</button></p>
      )}
      {ai.fake && <div className="banner">개발용 가짜 응답 모드입니다. 화면의 AI 결과는 실제 AI가 만든 것이 아닙니다.</div>}
      {error && <p className="error" role="alert">{error}</p>}

      <h2>생각 남기기</h2>
      <div className="card">
        <textarea aria-label="새 메모" placeholder="짧게, 미완성이어도 괜찮아요. 예: 두 실험은 측정 조건이 달라 보임. 숫자만 비교하면 오해할 수도"
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
      {notes === null && <p className="muted">불러오는 중…</p>}
      {notes?.length === 0 && <p className="muted">아직 메모가 없습니다.</p>}
      {notes?.map((n) => <NoteCard key={n.id} n={n} ai={ai} act={act} />)}

      <h2>작업</h2>
      <div className="card">
        <p><input aria-label="작업 제목" placeholder="작업 제목 (예: 비전공자 대상 3분 발표 구성)" value={task.title} maxLength={200}
          onChange={(e) => setTask({ ...task, title: e.target.value })} /></p>
        <p><input aria-label="목적" placeholder="목적" value={task.purpose} maxLength={1000} onChange={(e) => setTask({ ...task, purpose: e.target.value })} /></p>
        <p><input aria-label="대상" placeholder="대상" value={task.audience} maxLength={500} onChange={(e) => setTask({ ...task, audience: e.target.value })} /></p>
        <p><input aria-label="제약" placeholder="제약" value={task.constraints} maxLength={1000} onChange={(e) => setTask({ ...task, constraints: e.target.value })} /></p>
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

type Act = (fn: () => Promise<unknown>) => Promise<void>;

function NoteCard({ n, ai, act }: { n: NoteRow; ai: AiConfig; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.raw_text);
  const confirmedSummary = n.restated && n.intent_state !== "unconfirmed";
  const comparing = n.is_author && n.share_state !== "shared" && n.intent_state === "unconfirmed" && !!n.restated;

  const saveEdit = () =>
    act(() => api(`/api/notes/${n.id}`, { method: "PATCH", body: { rawText: text } })).then(() => setEditing(false));

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{n.author_name} · v{n.version}{!n.allow_external_ai && " · AI 정리 안 함"}</span>
        <span className={`badge ${n.share_state}`}>{STATE_LABEL[n.share_state]}</span>
      </div>
      {confirmedSummary && (
        <p style={{ margin: "6px 0 0" }}><strong>{n.restated!.summary}</strong>{" "}
          <span className="muted">({KIND_LABEL[n.restated!.kind] ?? n.restated!.kind} · 작성자 확인)</span></p>
      )}
      {editing ? (
        <div>
          <textarea aria-label="메모 수정" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          {n.share_state === "shared" && <p className="warn">저장하면 공유가 내려가고, 다시 확인한 뒤 공유해야 합니다. 이 메모를 근거로 쓴 조언은 무효가 됩니다.</p>}
          <div className="row">
            <button className="primary" disabled={!text.trim() || text === n.raw_text} onClick={saveEdit}>저장</button>
            <button onClick={() => { setEditing(false); setText(n.raw_text); }}>취소</button>
          </div>
        </div>
      ) : comparing ? (
        <Compare note={n} act={act} />
      ) : (
        <pre className="raw">{n.raw_text}</pre>
      )}
      {n.is_author && !editing && (
        <div className="row">
          {n.share_state !== "shared" && n.intent_state === "unconfirmed" && !n.restated && (
            <>
              {n.allow_external_ai && ai.available && (
                <button onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/restate`, { body: {} }))}>AI로 정리</button>
              )}
              <button onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/confirm`, {
                body: { choice: "raw_only", expectedHash: n.content_hash } }))}>원문 그대로 확인</button>
            </>
          )}
          {n.share_state !== "shared" && n.intent_state !== "unconfirmed" && (
            <button className="primary" onClick={() => act(() => api(`/api/notes/${n.id}/versions/${n.version_id}/share`, { body: {} }))}>팀에 공유</button>
          )}
          {n.share_state === "shared" && (
            <button onClick={() => act(() => api(`/api/notes/${n.id}/withdraw`, { body: {} }))}>철회</button>
          )}
          <button onClick={() => { setText(n.raw_text); setEditing(true); }}>수정</button>
          <button className="danger" onClick={() => confirm("삭제하면 되돌릴 수 없습니다. 이 메모를 근거로 쓴 조언 내용도 지워집니다. 삭제할까요?") &&
            act(() => api(`/api/notes/${n.id}`, { method: "DELETE" }))}>삭제</button>
        </div>
      )}
    </div>
  );
}

/** 원문과 AI 정리를 나란히 보여주고 작성자가 의도를 확인한다 (원안 §7.1-5~6). */
function Compare({ note, act }: { note: NoteRow; act: Act }) {
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
            ? <textarea aria-label="정리문 고치기" value={summary} maxLength={600} onChange={(e) => setSummary(e.target.value)} />
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
