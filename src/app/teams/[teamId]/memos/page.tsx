"use client";
// 내 원문 메모와 확인 후 공유한 지식을 구분하고, 기존 API와 권한을 그대로 사용한다.
import { use, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api-client.ts";
import { MEMO_SAVED_EVENT } from "../../../memo-fab.tsx";
import { usePanePicker } from "../../../pane-picker.ts";
import { AiBanner, TeamHeader, useAiConfig } from "../../team-header.tsx";

type MyMemo = { id: string; versionId: string; text: string; createdAt: string; inShared: boolean };
type SharedMemo = {
  id: string; versionId: string; text: string; state: "shared" | "withdrawn" | "draft"; isAuthor: boolean;
  authorName: string; allowExternalAi: boolean; visibility: "team" | "ai_only"; updatedAt: string;
};
type Memos = { mine: MyMemo[]; shared: SharedMemo[] };
type Draft = { text: string; sources: string[]; warnings: string[]; viaAi: boolean; allowAi: boolean };
type MemoFilter = "mine" | "team" | "authored";
type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>;

const fmt = (s: string) => new Date(s).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const titleOf = (text: string) => {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() || "메모";
  const characters = Array.from(firstLine);
  return characters.length > 36 ? `${characters.slice(0, 36).join("")}…` : firstLine;
};
const previewOf = (text: string) => text.trim().split("\n").slice(1).join(" ").trim().slice(0, 130) || text.trim().slice(0, 130);
const FILTERS: { key: MemoFilter; label: string }[] = [
  { key: "mine", label: "내 메모" }, { key: "team", label: "팀 공유" }, { key: "authored", label: "내 정리" },
];

export default function MemosPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const ai = useAiConfig();
  const [data, setData] = useState<Memos | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<MemoFilter>("mine");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const documentPane = useRef<HTMLElement>(null);
  const selectionToolbar = useRef<HTMLDivElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const focusNextDraft = useRef(false);
  const { picker, closeOnMobile } = usePanePicker();
  const editDirty = useRef(false);
  // 공유하기 전의 정리문도 저장되지 않은 내용이다. 화면을 떠나기 전에 확인한다.
  const draftOpen = useRef(false);
  draftOpen.current = !!draft;
  const reportDirty = useCallback((dirty: boolean) => { editDirty.current = dirty; }, []);
  const canLeaveEditor = () => !editDirty.current || confirm("저장하지 않은 수정 내용이 있습니다. 저장하지 않고 이동할까요?");
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!editDirty.current && !draftOpen.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  useEffect(() => {
    if (!draft || !focusNextDraft.current) return;
    focusNextDraft.current = false;
    const frame = requestAnimationFrame(() => draftInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [draft]);
  const openDraft = (next: Draft) => {
    focusNextDraft.current = true;
    closeOnMobile();
    setDraft(next);
  };
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
  const run: Run = async (label, fn) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); await load(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(null); }
  };
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pickedMemos = (data?.mine ?? []).filter((m) => picked.has(m.id));
  const selecting = filter === "mine" && picked.size > 0 && !draft;
  useEffect(() => {
    if (!selecting) return;
    const workspace = documentPane.current?.closest<HTMLElement>(".workspace");
    const list = picker.current;
    const toolbar = selectionToolbar.current;
    if (!workspace || !list || !toolbar) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = Math.ceil(toolbar.getBoundingClientRect().height);
      const top = list.querySelector<HTMLElement>(".pane-items")?.getBoundingClientRect().top ?? 0;
      workspace.style.setProperty("--memo-toolbar-height", `${height}px`);
      workspace.style.setProperty("--memo-list-height", `${Math.max(80, window.innerHeight - height - Math.max(0, top) - 8)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(toolbar);
    const sidebar = workspace.querySelector<HTMLElement>(".workspace-sidebar");
    if (sidebar) observer?.observe(sidebar);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    workspace.addEventListener("toggle", schedule, true);
    measure();
    return () => {
      observer?.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      workspace.removeEventListener("toggle", schedule, true);
      workspace.style.removeProperty("--memo-toolbar-height");
      workspace.style.removeProperty("--memo-list-height");
    };
  }, [selecting]);
  const summarize = () => {
    if (!canLeaveEditor()) return;
    closeOnMobile();
    return run("summarize", async () => {
      const r = await api<{ text: string; warnings: string[] }>(`/api/teams/${teamId}/memos/summarize`, { body: { noteIds: pickedMemos.map((m) => m.id) } });
      openDraft({ text: r.text, sources: pickedMemos.map((m) => m.id), warnings: r.warnings, viaAi: true, allowAi: true });
    });
  };
  const writeMyself = () => {
    if (!canLeaveEditor()) return;
    setError(""); setNotice("");
    openDraft({ text: pickedMemos.map((m) => m.text).join("\n"), sources: pickedMemos.map((m) => m.id), warnings: [], viaAi: false, allowAi: true });
  };
  // 공유·다시 정리가 진행되는 동안에는 정리문과 'AI도 참고' 선택을 잠근다(아래 입력란의 readOnly·disabled).
  // 요청은 누른 순간의 내용으로 나가고 끝나면 편집 화면을 닫으므로, 기다리는 동안 고친 것은 반영되지 않고 사라진다.
  const share = (visibility: "team" | "ai_only") => draft && run(`share-${visibility}`, async () => {
    await api(`/api/teams/${teamId}/shared`, { body: { text: draft.text, sourceNoteIds: draft.sources, allowExternalAi: visibility === "ai_only" || draft.allowAi, visibility } });
    setDraft(null); setPicked(new Set()); setFocusId(null); setFilter(visibility === "team" ? "team" : "authored");
    setNotice(visibility === "ai_only"
      ? "AI만 참고하도록 저장했습니다. 원문·출처는 팀원에게 표시되지 않지만, 필요한 내용은 답변에 반영될 수 있습니다."
      : draft.allowAi ? "팀에 공유했습니다. 팀원이 볼 수 있고, AI도 대화할 때 참고할 수 있습니다."
        : "팀에 공유했습니다. 팀원이 볼 수 있고, AI는 참고하지 않습니다.");
  });
  const rawMemos = data?.mine ?? [];
  // 팀 목록에는 현재 공개 중인 정리만. AI 전용·철회·초안은 작성자의 관리 목록에만 둔다.
  const sharedMemos = (data?.shared ?? []).filter((m) => filter === "team"
    ? m.visibility === "team" && m.state === "shared" : m.isAuthor);
  const visibleIds = filter === "mine" ? rawMemos.map((m) => m.id) : sharedMemos.map((m) => m.id);
  const selectedId = focusId && visibleIds.includes(focusId) ? focusId : visibleIds[0] ?? null;
  const selectedRaw = filter === "mine" ? rawMemos.find((m) => m.id === selectedId) : null;
  const selectedShared = filter !== "mine" ? sharedMemos.find((m) => m.id === selectedId) : null;
  const filterLabel = FILTERS.find((f) => f.key === filter)!.label;
  const changeFilter = (next: MemoFilter) => {
    if (next === filter || !canLeaveEditor()) return;
    setFilter(next); setFocusId(null);
  };
  const selectMemo = (id: string) => {
    if (id !== selectedId && !canLeaveEditor()) return;
    setFocusId(id);
    closeOnMobile();
    requestAnimationFrame(() => documentPane.current?.querySelector<HTMLHeadingElement>(".document-title")?.focus());
  };

  return (
    <main className={`workspace${selecting ? " memos-selecting" : ""}`}>
      <TeamHeader teamId={teamId} active="memos" />
      <section className="workspace-list memo-list" aria-label="메모 목록">
        <div className="pane-header"><h1 className="pane-title">메모</h1><p className="pane-subtitle">기록을 고르고, 내용을 읽어 보세요.</p></div>
        <details ref={picker} className="pane-picker">
          <summary>메모 목록 · {filterLabel}</summary>
          <div className="pane-items">
            <div className="pane-toolbar" aria-label="메모 범위">{FILTERS.map((f) => <button key={f.key} className={filter === f.key ? "on" : ""} aria-pressed={filter === f.key} disabled={!!draft || !!busy} onClick={() => changeFilter(f.key)}>{f.label}</button>)}</div>
            <p className="pane-subtitle">{filter === "mine" ? "나만 보는 원문 메모" : filter === "team" ? "팀원이 함께 볼 수 있는 정리" : "내가 확인해 저장한 정리와 공개 범위 관리"}</p>
            {data === null && <p className="pane-subtitle">불러오는 중…</p>}
            {data && visibleIds.length === 0 && <p className="pane-subtitle">{filter === "mine" ? "아직 메모가 없습니다. 메모하기로 생각을 남겨 보세요." : filter === "team" ? "아직 팀에 공유된 메모가 없습니다." : "아직 직접 저장한 정리가 없습니다."}</p>}
            {filter === "mine" ? rawMemos.map((m) => <div key={m.id} className={`list-item memo-index-item ${selectedId === m.id ? "selected" : ""}`}>
              <label className="memo-pick-target"><input type="checkbox" className="pick" aria-label={`${titleOf(m.text)} 정리 대상으로 선택`} checked={picked.has(m.id)} disabled={!!draft || !!busy} onChange={() => toggle(m.id)} /></label>
              <button className="list-item-content" aria-current={selectedId === m.id ? "true" : undefined} disabled={!!draft || !!busy} onClick={() => selectMemo(m.id)}><span className="list-item-title">{titleOf(m.text)}</span><span className="list-item-preview">{previewOf(m.text)}</span><span className="list-item-meta">{fmt(m.createdAt)}{m.inShared ? " · 정리에 포함됨" : ""}</span></button>
            </div>) : sharedMemos.map((s) => <button key={s.id} className={`list-item ${selectedId === s.id ? "selected" : ""}`} aria-current={selectedId === s.id ? "true" : undefined} disabled={!!busy} onClick={() => selectMemo(s.id)}><span className="list-item-title">{titleOf(s.text)}</span><span className="list-item-preview">{previewOf(s.text)}</span><span className="list-item-meta">{fmt(s.updatedAt)}{filter === "authored" ? ` · ${s.visibility === "ai_only" ? "AI만 참고" : "팀 공개"}${s.state === "withdrawn" ? " · 철회됨" : s.state === "draft" ? " · 공유 안 됨" : ""}` : ` · ${s.authorName}`}</span></button>)}
          </div>
        </details>
        {filter === "mine" && rawMemos.length > 0 && !draft && <div ref={selectionToolbar} className="pane-selection memo-selection-toolbar" role="region" aria-label="선택한 메모 정리"><p className="pane-subtitle" role="status">{picked.size ? `내 메모 ${picked.size}개 선택` : "체크한 메모를 모아 정리할 수 있습니다."}</p><div className="pane-toolbar"><button className="primary" disabled={!picked.size || !ai.available || !!busy} onClick={summarize}>{busy === "summarize" ? "정리하는 중…" : "AI로 정리"}</button><button disabled={!picked.size || !!busy} onClick={writeMyself}>직접 정리</button></div><p className="pane-subtitle">AI로 정리하면 선택한 메모만 AI에 보냅니다.</p></div>}
      </section>
      <section ref={documentPane} className="workspace-document" aria-label="메모 내용">
        <AiBanner ai={ai} />
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="okc" role="status">{notice}</p>}
        {draft ? <article className="memo-composer">
          <header className="document-header"><p className="document-meta">내 메모 {draft.sources.length}개 바탕 · 아직 공유되지 않음</p><h1 className="document-title" tabIndex={-1}>{draft.viaAi ? "정리한 내용 확인" : "직접 정리"}</h1><p className="document-meta">불필요한 부분은 지우고 고친 뒤 공개 범위를 고르세요.</p></header>
          <div className="document-body"><label className="field-label" htmlFor="memo-share-text">확인할 내용</label><textarea ref={draftInput} id="memo-share-text" aria-label="공유할 내용" className="document-editor" rows={10} maxLength={2000} value={draft.text} readOnly={!!busy} aria-busy={!!busy} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            {draft.warnings.map((w, i) => <p key={i} className="warn">{w}</p>)}
            <details className="ev"><summary>바탕이 된 내 메모</summary>{rawMemos.filter((m) => draft.sources.includes(m.id)).map((m) => <blockquote key={m.id}>{m.text}</blockquote>)}</details>
            <h2>공개 범위</h2><div className="share-choice">
              <div><h3>팀에 공유</h3><p className="muted">팀원이 내용을 볼 수 있습니다.{draft.allowAi ? " AI도 대화할 때 참고할 수 있습니다." : " AI는 참고하지 않습니다."}</p><label className="check memo-ai"><input type="checkbox" checked={draft.allowAi} disabled={!!busy} onChange={(e) => setDraft({ ...draft, allowAi: e.target.checked })} />AI도 참고하도록 허용</label><button className="primary" disabled={!draft.text.trim() || !!busy} onClick={() => share("team")}>{busy === "share-team" ? "공유 중…" : "팀에 공유"}</button></div>
              <div><h3>AI만 참고</h3><p className="muted">원문·출처는 팀원에게 표시되지 않지만, 일정·장소 등 필요한 내용은 답변에 반영될 수 있습니다. 팀원이 알면 안 되는 비밀은 적지 마세요.</p><button disabled={!draft.text.trim() || !!busy} onClick={() => share("ai_only")}>{busy === "share-ai_only" ? "저장 중…" : "AI만 참고로 저장"}</button></div>
            </div>
            <div className="row document-actions">{draft.viaAi && <button disabled={!!busy} onClick={summarize}>다시 정리</button>}<button disabled={!!busy} onClick={() => setDraft(null)}>취소</button></div>
          </div>
        </article> : selectedRaw ? <MyMemoCard key={selectedRaw.id} m={selectedRaw} checked={picked.has(selectedRaw.id)} onToggle={() => toggle(selectedRaw.id)} run={run} busy={!!busy} onDirtyChange={reportDirty} /> : selectedShared ? <SharedCard key={selectedShared.id} s={selectedShared} run={run} busy={!!busy} onDirtyChange={reportDirty} /> : <div className="document-header"><h1 className="document-title" tabIndex={-1}>{data === null ? "메모를 불러오는 중…" : filter === "mine" ? "내 메모" : filter === "team" ? "팀에 공유된 메모" : "내가 저장한 정리"}</h1><p className="document-meta">{data === null ? "잠시만 기다려 주세요." : "목록에서 읽을 메모를 고르세요."}</p></div>}
      </section>
    </main>
  );
}

function MyMemoCard({ m, checked, onToggle, run, busy, onDirtyChange }: { m: MyMemo; checked: boolean; onToggle: () => void; run: Run; busy: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  useEffect(() => {
    onDirtyChange(editing && text !== m.text);
    return () => onDirtyChange(false);
  }, [editing, text, m.text, onDirtyChange]);
  return <article className="memo-document">
    <header className="document-header"><p className="document-meta">내 원문 메모 · 나만 봄 · {fmt(m.createdAt)}</p><h1 className="document-title" tabIndex={-1}>{titleOf(m.text)}</h1>{m.inShared && <p className="document-meta">내가 공유한 정리에 포함된 메모입니다.</p>}</header>
    <div className="document-body">{editing ? <><label className="field-label" htmlFor="raw-memo-edit">메모 수정</label><textarea id="raw-memo-edit" aria-label="메모 수정" className="document-editor" rows={10} disabled={busy} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} /><div className="row document-actions"><button className="primary" disabled={busy || !text.trim() || text === m.text} onClick={() => run("edit", () => api(`/api/notes/${m.id}`, { method: "PATCH", body: { rawText: text } })).then((ok) => ok && setEditing(false))}>저장</button><button disabled={busy} onClick={() => { setEditing(false); setText(m.text); }}>취소</button></div></> : <><pre className="raw">{m.text}</pre><div className="document-actions"><label className="check"><input type="checkbox" checked={checked} disabled={busy} onChange={onToggle} />정리할 메모에 포함</label><p className="muted">선택한 원문은 직접 확인하고 고친 뒤 공개 범위를 고를 수 있습니다.</p><div className="row"><button className="small" disabled={busy} onClick={() => { setText(m.text); setEditing(true); }}>수정</button><button className="small danger" disabled={busy} onClick={() => confirm("이 메모를 삭제할까요? 되돌릴 수 없습니다.") && run("delete", () => api(`/api/notes/${m.id}`, { method: "DELETE" }))}>삭제</button></div></div></>}</div>
  </article>;
}

function SharedCard({ s, run, busy, onDirtyChange }: { s: SharedMemo; run: Run; busy: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  useEffect(() => {
    onDirtyChange(editing && text !== s.text);
    return () => onDirtyChange(false);
  }, [editing, text, s.text, onDirtyChange]);
  return <article className="memo-document">
    <header className="document-header"><p className="document-meta">{s.authorName}{s.isAuthor ? " (나)" : ""} · {fmt(s.updatedAt)}</p><h1 className="document-title" tabIndex={-1}>{titleOf(s.text)}</h1><p className="document-meta">{s.state !== "shared" ? s.state === "withdrawn" ? "공유 철회됨 · 나만 봄" : "공유 안 됨 · 나만 봄" : s.visibility === "team" ? "팀에 공개" : "AI만 참고 · 원문과 출처는 팀원에게 표시되지 않음"}{!s.allowExternalAi && s.visibility === "team" ? " · AI 참고 안 함" : ""}</p></header>
    <div className="document-body">
      {s.isAuthor && s.visibility === "ai_only" && <p className="muted">원문·출처는 팀원에게 표시되지 않지만, 필요한 내용(일정·장소 등)은 답변에 반영될 수 있습니다. 이는 비밀 유지를 보장하는 기능이 아닙니다. 팀원이 알면 안 되는 비밀은 적지 마세요.</p>}
      {editing ? <><label className="field-label" htmlFor="shared-memo-edit">정리문 수정</label><textarea id="shared-memo-edit" aria-label="공유 메모 수정" className="document-editor" rows={10} disabled={busy} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} /><p className="muted">저장하면 현재 공개 범위로 다시 공유됩니다.</p><div className="row document-actions"><button className="primary small" disabled={busy || !text.trim() || text === s.text} onClick={() => run("revise", () => api(`/api/notes/${s.id}/revise`, { body: { text } })).then((ok) => ok && setEditing(false))}>저장하고 다시 공유</button><button className="small" disabled={busy} onClick={() => { setEditing(false); setText(s.text); }}>취소</button></div></> : <pre className="raw">{s.text}</pre>}
      {s.isAuthor && !editing && <div className="document-actions">{s.visibility === "team" && <label className="check memo-ai"><input type="checkbox" checked={s.allowExternalAi} disabled={busy} onChange={(e) => run("ai", () => api(`/api/notes/${s.id}/ai`, { method: "PATCH", body: { allowExternalAi: e.target.checked } }))} />AI가 대화할 때 참고하도록 허용</label>}
        <div className="row"><button className="small" disabled={busy} onClick={() => { setText(s.text); setEditing(true); }}>수정</button>
          {s.state === "shared" && <button className="small" disabled={busy} onClick={() => run("withdraw", () => api(`/api/notes/${s.id}/withdraw`, { body: {} }))}>공유 철회</button>}
          {s.state === "withdrawn" && <button className="small" disabled={busy} onClick={() => run("reshare", () => api(`/api/notes/${s.id}/versions/${s.versionId}/share`, { body: {} }))}>다시 공유</button>}
          {s.visibility === "team" ? <button className="small" disabled={busy} onClick={() => confirm("이 메모를 AI만 참고하도록 바꿀까요? 원문·출처는 팀원에게 표시되지 않지만, 필요한 내용은 답변에 반영될 수 있습니다. 이미 본 팀원의 기억까지 지울 수는 없습니다.") && run("vis", () => api(`/api/notes/${s.id}/visibility`, { method: "PATCH", body: { visibility: "ai_only" } }))}>AI만 참고로 변경</button> : <button className="small" disabled={busy} onClick={() => confirm("이 메모를 팀원에게도 보이게 할까요?") && run("vis", () => api(`/api/notes/${s.id}/visibility`, { method: "PATCH", body: { visibility: "team" } }))}>팀에 공개로 변경</button>}
          <button className="small danger" disabled={busy} onClick={() => confirm("삭제하면 되돌릴 수 없습니다. 삭제할까요?") && run("delete", () => api(`/api/notes/${s.id}`, { method: "DELETE" }))}>삭제</button>
        </div>
      </div>}
    </div>
  </article>;
}
