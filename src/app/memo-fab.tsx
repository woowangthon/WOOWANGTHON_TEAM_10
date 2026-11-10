"use client";
// 어느 화면에서든 위쪽 고정 막대에 있는 '메모하기' 버튼. 쓴 메모는 나만 보며, '메모 보기'에서 골라 정리해 공유한다.
import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api-client.ts";

export const MEMO_SAVED_EVENT = "mijuk:memo-saved";

type TeamOption = { id: string; name: string };

export function MemoFab({ teamId, teams }: { teamId?: string; teams?: TeamOption[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [target, setTarget] = useState(teamId ?? teams?.[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const memoId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (teamId) setTarget(teamId); else if (!target && teams?.[0]) setTarget(teams[0].id); }, [teamId, teams]);
  useEffect(() => {
    if (!open) return;
    // 클릭해도 버튼에 포커스가 가지 않는 브라우저(Safari)에서는 body 가 잡히므로, 그때는 '메모하기' 버튼으로 돌아간다
    const active = document.activeElement;
    const previousFocus = active instanceof HTMLElement && active !== document.body ? active : trigger.current;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      const outside = !dialog.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || outside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || outside)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
      else trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 6000);
    return () => clearTimeout(t);
  }, [saved]);

  if (!teamId && !teams?.length) return null;

  const save = async () => {
    if (!text.trim() || busy || !target) return;
    setBusy(true); setError("");
    try {
      await api(`/api/teams/${target}/memos`, { body: { text } });
      setText(""); setOpen(false); setSaved(target);
      window.dispatchEvent(new Event(MEMO_SAVED_EVENT));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button ref={trigger} className="memo-btn" onClick={() => { setOpen(true); setSaved(null); }} aria-haspopup="dialog" aria-expanded={open}>메모하기</button>
      {saved && (
        <div className="toast" role="status">메모를 저장했습니다 (나만 봄) · <a href={`/teams/${saved}/memos`}>메모 보기</a></div>
      )}
      {open && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby={`${memoId}-heading`}>
            <div className="modal-heading"><h2 id={`${memoId}-heading`} style={{ marginTop: 0 }}>메모하기</h2><button type="button" className="small" onClick={() => setOpen(false)} aria-label="메모 창 닫기">닫기</button></div>
            {!teamId && teams && teams.length > 1 && (
              <p><label className="field-label" htmlFor={`${memoId}-team`}>팀 선택</label><select id={`${memoId}-team`} aria-label="팀 선택" value={target} onChange={(e) => setTarget(e.target.value)}>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select></p>
            )}
            <label className="field-label" htmlFor={memoId}>메모</label><textarea id={memoId} ref={box} aria-label="메모" rows={5} maxLength={2000} value={text}
              placeholder="떠오른 생각을 짧게 적어 두세요. 미완성이어도 괜찮아요."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && text.trim() && !busy) { e.preventDefault(); save(); } }} />
            <p className="muted">나만 보는 메모로 저장됩니다. 팀과 나누려면 &lsquo;메모 보기&rsquo;에서 골라 정리한 뒤 공유하세요.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row">
              <button className="primary" disabled={!text.trim() || busy || !target} onClick={save}>{busy ? "저장 중…" : "내 메모에 저장"}</button>
              <button onClick={() => setOpen(false)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
