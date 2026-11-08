"use client";
// 메모 보기: 내 메모(나만 봄)를 골라 AI 로 정리 → 직접 고침 → 공유.
// 공유할 때 범위를 고른다: '팀에 공유'(팀원도 보고 AI 도 참고) 또는 'AI만 참고'(팀원은 못 보고 AI 만 대화할 때 참고).
import { use, useEffect, useState } from "react";
import { api } from "../../../api-client.ts";
import { MEMO_SAVED_EVENT } from "../../../memo-fab.tsx";
import { AiBanner, TeamHeader, useAiConfig } from "../../team-header.tsx";

type MyMemo = { id: string; versionId: string; text: string; createdAt: string; inShared: boolean };
type SharedMemo = {
  id: string; versionId: string; text: string; state: "shared" | "withdrawn" | "draft"; isAuthor: boolean;
  authorName: string; allowExternalAi: boolean; visibility: "team" | "ai_only"; updatedAt: string;
};
type Memos = { mine: MyMemo[]; shared: SharedMemo[] };
type Draft = { text: string; sources: string[]; warnings: string[]; viaAi: boolean; allowAi: boolean };

const fmt = (s: string) => new Date(s).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function MemosPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const ai = useAiConfig();
  const [data, setData] = useState<Memos | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api<Memos>(`/api/teams/${teamId}/memos`).then((d) => {
    setData(d);
    setPicked((prev) => new Set([...prev].filter((id) => d.mine.some((m) => m.id === id))));
  }, (e) => setError((e as Error).message));
  useEffect(() => {
    load();
    const onSaved = () => load();
    window.addEventListener(MEMO_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(MEMO_SAVED_EVENT, onSaved);
  }, [teamId]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pickedMemos = (data?.mine ?? []).filter((m) => picked.has(m.id));

  const summarize = () => run("summarize", async () => {
    const r = await api<{ text: string; warnings: string[] }>(`/api/teams/${teamId}/memos/summarize`, { body: { noteIds: pickedMemos.map((m) => m.id) } });
    setDraft({ text: r.text, sources: pickedMemos.map((m) => m.id), warnings: r.warnings, viaAi: true, allowAi: true });
  });
  const writeMyself = () => {
    setError("");
    setDraft({ text: pickedMemos.map((m) => m.text).join("\n"), sources: pickedMemos.map((m) => m.id), warnings: [], viaAi: false, allowAi: true });
  };
  const share = (visibility: "team" | "ai_only") => draft && run(`share-${visibility}`, async () => {
    await api(`/api/teams/${teamId}/shared`, { body: { text: draft.text, sourceNoteIds: draft.sources, allowExternalAi: visibility === "ai_only" || draft.allowAi, visibility } });
    setDraft(null); setPicked(new Set());
    setNotice(visibility === "ai_only"
      ? "AI만 참고하도록 저장했습니다. 팀원에게는 보이지 않고, AI가 대화할 때 참고합니다."
      : "팀에 공유했습니다. 팀원이 볼 수 있고, AI가 대화할 때 참고합니다.");
  });
  const teamShared = (data?.shared ?? []).filter((x) => x.visibility === "team");
  const aiOnly = (data?.shared ?? []).filter((x) => x.visibility === "ai_only");

  return (
    <main>
      <TeamHeader teamId={teamId} active="memos" />
      <AiBanner ai={ai} />
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="okc" role="status">{notice}</p>}

      <h2>내 메모 <span className="muted">· 나만 봄</span></h2>
      {data === null && <p className="muted">불러오는 중…</p>}
      {data?.mine.length === 0 && <p className="muted">아직 메모가 없습니다. 위쪽 &lsquo;✎ 메모하기&rsquo;로 언제든 적어 두세요.</p>}
      {data?.mine.map((m) => <MyMemoCard key={m.id} m={m} checked={picked.has(m.id)} onToggle={() => toggle(m.id)} run={run} disabled={!!draft} />)}

      {!!data?.mine.length && !draft && (
        <div className="action-bar">
          <span className="muted">{picked.size ? `${picked.size}개 선택` : "공유할 메모를 골라 주세요"}</span>
          <button className="primary" disabled={!picked.size || !ai.available || busy === "summarize"} onClick={summarize}>
            {busy === "summarize" ? "정리하는 중…" : "선택한 메모 AI로 정리하기"}</button>
          <button disabled={!picked.size} onClick={writeMyself}>직접 정리하기</button>
        </div>
      )}

      {draft && (
        <div className="card composer">
          <h3 style={{ marginTop: 0 }}>{draft.viaAi ? "AI가 정리한 내용" : "직접 정리"} <span className="muted">· 메모 {draft.sources.length}개 바탕</span></h3>
          <p className="muted">불필요한 부분은 지우고 고친 뒤 공유 범위를 고르세요. 여기 적힌 그대로 저장됩니다.</p>
          <textarea aria-label="공유할 내용" rows={8} maxLength={2000} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          {draft.warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}
          <details className="ev">
            <summary>바탕이 된 내 메모 보기</summary>
            {(data?.mine ?? []).filter((m) => draft.sources.includes(m.id)).map((m) => <blockquote key={m.id}>{m.text}</blockquote>)}
          </details>
          <div className="share-choice">
            <div>
              <button className="primary" disabled={!draft.text.trim() || !!busy} onClick={() => share("team")}>{busy === "share-team" ? "공유 중…" : "팀에 공유"}</button>
              <p className="muted">팀원도 보고, AI도 대화할 때 참고합니다.</p>
              <label className="check" style={{ fontSize: ".85rem" }}>
                <input type="checkbox" checked={draft.allowAi} onChange={(e) => setDraft({ ...draft, allowAi: e.target.checked })} />
                AI도 참고 (끄면 팀원만 봄)</label>
            </div>
            <div>
              <button className="ai-only-btn" disabled={!draft.text.trim() || !!busy} onClick={() => share("ai_only")}>{busy === "share-ai_only" ? "저장 중…" : "AI만 참고"}</button>
              <p className="muted">팀원에게는 보이지 않습니다. AI만 대화할 때 참고해 팀원의 질문에 반영합니다.</p>
            </div>
          </div>
          <div className="row">
            {draft.viaAi && <button disabled={busy === "summarize"} onClick={summarize}>다시 정리</button>}
            <button onClick={() => setDraft(null)}>취소</button>
          </div>
        </div>
      )}

      <h2>팀에 공유된 메모</h2>
      {data && teamShared.length === 0 && <p className="muted">아직 공유된 메모가 없습니다.</p>}
      {teamShared.map((s) => <SharedCard key={s.id} s={s} run={run} />)}

      {aiOnly.length > 0 && (
        <>
          <h2>AI만 참고하는 내 메모 <span className="muted">· 팀원에게 보이지 않음</span></h2>
          <p className="muted">AI는 팀원이 질문할 때 이 내용을 참고해 답하지만, 원문을 그대로 옮기지는 않습니다.</p>
          {aiOnly.map((s) => <SharedCard key={s.id} s={s} run={run} />)}
        </>
      )}
    </main>
  );
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>;

function MyMemoCard({ m, checked, onToggle, run, disabled }: { m: MyMemo; checked: boolean; onToggle: () => void; run: Run; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  return (
    <div className={`card memo ${checked ? "picked" : ""}`}>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        <input type="checkbox" className="pick" aria-label="이 메모 선택" checked={checked} disabled={disabled || editing} onChange={onToggle} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <>
              <textarea aria-label="메모 수정" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="primary small" disabled={!text.trim() || text === m.text}
                  onClick={() => run("edit", () => api(`/api/notes/${m.id}`, { method: "PATCH", body: { rawText: text } })).then(() => setEditing(false))}>저장</button>
                <button className="small" onClick={() => { setEditing(false); setText(m.text); }}>취소</button>
              </div>
            </>
          ) : (
            <pre className="raw" onClick={() => !disabled && onToggle()}>{m.text}</pre>
          )}
          <div className="row muted memo-meta">
            <span>{fmt(m.createdAt)}</span>
            {m.inShared && <span className="badge shared">공유한 정리에 포함됨</span>}
            {!editing && (
              <span className="row" style={{ marginLeft: "auto" }}>
                <button className="small" onClick={() => { setText(m.text); setEditing(true); }}>수정</button>
                <button className="small danger" onClick={() => confirm("이 메모를 삭제할까요? 되돌릴 수 없습니다.") &&
                  run("delete", () => api(`/api/notes/${m.id}`, { method: "DELETE" }))}>삭제</button>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SharedCard({ s, run }: { s: SharedMemo; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{s.authorName}{s.isAuthor ? " (나)" : ""} · {fmt(s.updatedAt)}{!s.allowExternalAi && !s.isAuthor && " · AI 참고 안 함"}</span>
        {s.state !== "shared" && <span className="badge withdrawn">{s.state === "withdrawn" ? "공유 철회됨 (나만 봄)" : "공유 안 됨 (나만 봄)"}</span>}
      </div>
      {editing ? (
        <>
          <textarea aria-label="공유 메모 수정" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          <p className="muted">저장하면 고친 내용으로 다시 공유됩니다.</p>
          <div className="row">
            <button className="primary small" disabled={!text.trim() || text === s.text}
              onClick={() => run("revise", () => api(`/api/notes/${s.id}/revise`, { body: { text } })).then(() => setEditing(false))}>저장하고 다시 공유</button>
            <button className="small" onClick={() => { setEditing(false); setText(s.text); }}>취소</button>
          </div>
        </>
      ) : (
        <pre className="raw">{s.text}</pre>
      )}
      {s.isAuthor && !editing && s.visibility === "team" && (
        <label className="check memo-ai">
          <input type="checkbox" checked={s.allowExternalAi}
            onChange={(e) => run("ai", () => api(`/api/notes/${s.id}/ai`, { method: "PATCH", body: { allowExternalAi: e.target.checked } }))} />
          AI가 대화할 때 참고</label>
      )}
      {s.isAuthor && !editing && (
        <div className="row">
          <button className="small" onClick={() => { setText(s.text); setEditing(true); }}>수정</button>
          {s.state === "shared" && (
            <button className="small" onClick={() => run("withdraw", () => api(`/api/notes/${s.id}/withdraw`, { body: {} }))}>공유 철회</button>
          )}
          {s.state === "withdrawn" && (
            <button className="small" onClick={() => run("reshare", () => api(`/api/notes/${s.id}/versions/${s.versionId}/share`, { body: {} }))}>다시 공유</button>
          )}
          {s.visibility === "team"
            ? <button className="small" onClick={() => confirm("팀원 화면에서 이 메모를 숨기고 AI만 참고하게 할까요? 이미 본 팀원의 기억까지 지울 수는 없습니다.") &&
                run("vis", () => api(`/api/notes/${s.id}/visibility`, { method: "PATCH", body: { visibility: "ai_only" } }))}>팀원에게 숨기기</button>
            : <button className="small" onClick={() => confirm("이 메모를 팀원에게도 보이게 할까요?") &&
                run("vis", () => api(`/api/notes/${s.id}/visibility`, { method: "PATCH", body: { visibility: "team" } }))}>팀원에게 공개</button>}
          <button className="small danger" onClick={() => confirm("삭제하면 되돌릴 수 없습니다. 삭제할까요?") &&
            run("delete", () => api(`/api/notes/${s.id}`, { method: "DELETE" }))}>삭제</button>
        </div>
      )}
    </div>
  );
}
