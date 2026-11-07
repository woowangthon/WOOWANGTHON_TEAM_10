"use client";
// 회의록: 팀원끼리 회의한 내용을 적어 두면 AI 가 대화할 때 참고한다. 쓰는 즉시 팀에 공유되고, 팀원 누구나 고칠 수 있다.
// 누가 어떤 부분을 고쳤는지는 '수정 기록'에서 버전별로 비교해 본다.
import { use, useEffect, useState } from "react";
import { compactDiff, diffLines } from "../../../../lib/diff.ts";
import { api } from "../../../api-client.ts";
import { TeamHeader } from "../../team-header.tsx";

type Meeting = {
  id: string; versionId: string; version: number; title: string; date: string; text: string; state: "shared" | "withdrawn";
  allowExternalAi: boolean; isAuthor: boolean; canManage: boolean; authorName: string; createdAt: string;
  lastEditedBy: string; lastEditedAt: string;
};
type Version = { versionId: string; version: number; title: string | null; date: string | null; text: string; at: string; editorName: string };
type Form = { title: string; date: string; text: string; allowExternalAi: boolean };
type Run = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const TEMPLATE = "결정한 것:\n- \n\n아직 정하지 못한 것:\n- \n\n할 일 (누가, 언제까지):\n- ";
const fmtDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일`;
};
const fmtTime = (s: string) => new Date(s).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function MeetingsPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(params);
  const [items, setItems] = useState<Meeting[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api<Meeting[]>(`/api/teams/${teamId}/meetings`).then(setItems, (e) => setError((e as Error).message));
  useEffect(() => { load(); }, [teamId]);

  const run: Run = async (fn, done) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await load(); if (done) setNotice(done); return true; }
    catch (e) { setError((e as Error).message); await load(); return false; }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!form) return;
    if (await run(() => api(`/api/teams/${teamId}/meetings`, { body: form }), "회의록을 팀에 공유했습니다. AI가 대화할 때 참고합니다.")) setForm(null);
  };

  return (
    <main>
      <TeamHeader teamId={teamId} active="meetings" />
      <p className="muted">회의에서 정한 것, 아직 정하지 못한 것, 할 일을 적어 두세요. 팀원 모두가 보고 고칠 수 있으며, AI가 대화할 때 맥락으로 참고합니다.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="okc" role="status">{notice}</p>}

      {form ? (
        <MeetingEditor value={form} onChange={setForm} onSave={save} onCancel={() => setForm(null)} busy={busy} saveLabel="팀에 공유" />
      ) : (
        <p><button className="primary" onClick={() => setForm({ title: "", date: today(), text: TEMPLATE, allowExternalAi: true })}>＋ 회의록 추가</button></p>
      )}

      {items === null && <p className="muted">불러오는 중…</p>}
      {items?.length === 0 && !form && <p className="muted">아직 회의록이 없습니다.</p>}
      {items?.map((m) => <MeetingCard key={m.id} m={m} run={run} busy={busy} />)}
    </main>
  );
}

function MeetingEditor({ value, onChange, onSave, onCancel, busy, saveLabel, showAiToggle = true }: {
  value: Form; onChange: (v: Form) => void; onSave: () => void; onCancel: () => void; busy: boolean; saveLabel: string; showAiToggle?: boolean;
}) {
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 200px", margin: "0 0 8px" }}>
          <label className="field-label" htmlFor="mt-title">회의 제목</label>
          <input id="mt-title" placeholder="예: 발표 구성 회의" value={value.title} maxLength={200} onChange={(e) => onChange({ ...value, title: e.target.value })} />
        </p>
        <p style={{ flex: "0 0 170px", margin: "0 0 8px" }}>
          <label className="field-label" htmlFor="mt-date">날짜</label>
          <input id="mt-date" type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
        </p>
      </div>
      <label className="field-label" htmlFor="mt-text">회의 내용</label>
      <textarea id="mt-text" rows={12} maxLength={10000} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
      <p className="muted" style={{ margin: "4px 0" }}>{value.text.length.toLocaleString()} / 10,000자 · 회의 녹음 요약이나 메신저 대화를 붙여 넣어도 됩니다.</p>
      {showAiToggle && (
        <label className="check" style={{ margin: "8px 0" }}>
          <input type="checkbox" checked={value.allowExternalAi} onChange={(e) => onChange({ ...value, allowExternalAi: e.target.checked })} />
          AI가 대화할 때 이 회의록을 참고해도 됨</label>
      )}
      <div className="row">
        <button className="primary" disabled={busy || !value.title.trim() || !value.text.trim() || !value.date} onClick={onSave}>{busy ? "저장 중…" : saveLabel}</button>
        <button onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}

function MeetingCard({ m, run, busy }: { m: Meeting; run: Run; busy: boolean }) {
  const [editing, setEditing] = useState<(Form & { base: string }) | null>(null);
  const [history, setHistory] = useState<Version[] | null>(null);
  const manage = (action: string, extra: object = {}) => run(() => api(`/api/meetings/${m.id}/manage`, { body: { action, ...extra } }));

  if (editing) {
    return (
      <MeetingEditor value={editing} onChange={(v) => setEditing({ ...v, base: editing.base })} busy={busy} saveLabel="저장" showAiToggle={false}
        onCancel={() => setEditing(null)}
        onSave={async () => {
          const { base, ...body } = editing;
          if (await run(() => api(`/api/meetings/${m.id}`, { method: "PATCH", body: { ...body, baseVersionId: base } }), "회의록을 고쳤습니다. 수정 기록에 남았습니다.")) setEditing(null);
        }} />
    );
  }
  const edited = m.version > 1;
  return (
    <details className="card meeting">
      <summary>
        <strong>{m.title}</strong>
        <span className="muted"> · {fmtDate(m.date)}</span>
        {m.state === "withdrawn" && <span className="badge withdrawn"> 공유 철회됨</span>}
        {!m.allowExternalAi && <span className="badge"> AI 참고 안 함</span>}
        <div className="muted meeting-meta">
          처음 쓴 사람 {m.authorName}{m.isAuthor ? " (나)" : ""}
          {edited && <> · 마지막 수정 {m.lastEditedBy} ({fmtTime(m.lastEditedAt)})</>}
        </div>
      </summary>
      <pre className="raw">{m.text}</pre>
      <div className="row">
        <button className="small" onClick={() => setEditing({ title: m.title, date: m.date, text: m.text, allowExternalAi: m.allowExternalAi, base: m.versionId })}>수정</button>
        <button className="small" onClick={() => (history ? setHistory(null) : api<Version[]>(`/api/meetings/${m.id}/history`).then(setHistory, () => setHistory([])))}>
          {history ? "수정 기록 닫기" : `수정 기록${edited ? ` (${m.version - 1})` : ""}`}</button>
      </div>
      {history && <History versions={history} />}
      {m.canManage && (
        <div className="manage">
          <label className="check memo-ai">
            <input type="checkbox" checked={m.allowExternalAi} onChange={(e) => manage("ai", { allowExternalAi: e.target.checked })} />
            AI가 대화할 때 참고</label>
          <div className="row">
            {m.state === "shared"
              ? <button className="small" onClick={() => manage("withdraw")}>공유 철회</button>
              : <button className="small" onClick={() => manage("share")}>다시 공유</button>}
            <button className="small danger" onClick={() => confirm("이 회의록을 삭제할까요? 수정 기록까지 모두 지워지며 되돌릴 수 없습니다.") && manage("delete")}>삭제</button>
            <span className="muted" style={{ fontSize: ".8rem" }}>처음 쓴 사람·팀장만 할 수 있어요</span>
          </div>
        </div>
      )}
    </details>
  );
}

/** 버전별로 누가 언제 무엇을 고쳤는지: 바로 앞 버전과 비교해 더한 줄·지운 줄을 보여준다 */
function History({ versions }: { versions: Version[] }) {
  if (!versions.length) return <p className="muted">수정 기록을 불러오지 못했습니다.</p>;
  return (
    <ol className="history">
      {versions.map((v, i) => {
        const prev = versions[i + 1];
        const label = <><strong>{v.editorName}</strong> <span className="muted">· {fmtTime(v.at)} · v{v.version}</span></>;
        if (!prev) return <li key={v.versionId}>{label} <span className="muted">— {v.version === 1 ? "처음 작성" : "이전 기록은 생략"}</span></li>;
        const changes: string[] = [];
        if (prev.title !== v.title) changes.push(`제목: “${prev.title ?? ""}” → “${v.title ?? ""}”`);
        if (prev.date !== v.date) changes.push(`날짜: ${prev.date ? fmtDate(prev.date) : "-"} → ${v.date ? fmtDate(v.date) : "-"}`);
        const lines = prev.text === v.text ? [] : compactDiff(diffLines(prev.text, v.text));
        return (
          <li key={v.versionId}>
            {label}
            {changes.map((c, j) => <div key={j} className="muted">{c}</div>)}
            {lines.length > 0 && (
              <div className="diff">
                {lines.map((l, j) => l.op === "skip"
                  ? <div key={j} className="diff-skip">… 같은 줄 {l.count}개 …</div>
                  : <div key={j} className={`diff-${l.op}`}>{l.op === "add" ? "+ " : l.op === "del" ? "− " : "  "}{l.text || " "}</div>)}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
