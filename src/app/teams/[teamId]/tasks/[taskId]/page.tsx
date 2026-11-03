"use client";
import { use, useEffect, useState } from "react";
import { api } from "../../../../api-client.ts";

type AiConfig = { provider: string; available: boolean; fake: boolean };
type Task = { id: string; title: string; purpose: string; audience: string; constraints: string; version: number };
type Evidence =
  | { versionId: string; available: false }
  | { versionId: string; available: true; noteId: string; authorName: string; text: string; summary: string | null; quote: string | null };
type Item = {
  id: string; section: string; body: string | null; hidden: boolean; keywordOnly: boolean; evidence: Evidence[];
  myReaction: { reaction: "apply" | "hold" | "exclude"; reason: string | null } | null; declinedEarlier: boolean;
};
type Advice = {
  id: string; status: string; error: string | null; provider: string; emptyReason: string | null; droppedCount: number;
  createdAt: string; question: string; taskChanged: boolean; hints: string[]; items: Item[];
};
type RequestRow = { id: string; status: string; provider: string; created_at: string; item_count: number };

// 출처와 AI 추가 내용을 구분해 보여주는 구획 (원안 §7.3)
const SECTIONS = [
  { key: "direct", label: "팀 메모에 있는 내용", note: "작성자가 확인한 원문이 근거입니다." },
  { key: "link_reason", label: "지금 작업과 연결한 이유", note: "AI의 해석입니다." },
  { key: "ai_extension", label: "메모를 바탕으로 한 AI 확장", note: "새 가정이 들어 있을 수 있습니다." },
  { key: "objection", label: "반론 · 확인할 것", note: "확정된 사실이 아닙니다." },
  { key: "extra", label: "팀 메모 근거 없는 AI 일반 제안", note: "팀원의 의견이 아닙니다." },
] as const;

const STATUS_TEXT: Record<string, string> = { ok: "완료", pending: "처리 중", failed: "실패", invalidated: "무효" };
const ERROR_TEXT: Record<string, string> = {
  ai_timeout: "AI 응답이 늦어 중단했습니다. 다시 시도해 주세요.",
  ai_error: "AI 호출에 실패했습니다. 다시 시도해 주세요.",
  invalid_ai_output: "AI 응답 형식이 올바르지 않아 아무것도 표시하지 않았습니다.",
  stale: "처리가 중간에 멈췄습니다. 다시 요청해 주세요.",
  internal: "일시적인 오류가 발생했습니다.",
  source_changed: "근거로 쓴 메모가 철회·수정·삭제되어 이 조언은 무효가 되었습니다. 다시 요청해 주세요.",
  task_changed: "작업 내용이 바뀌어 이 조언은 무효가 되었습니다. 다시 요청해 주세요.",
};
const REACTION_TEXT = { apply: "적용", hold: "보류", exclude: "제외" } as const;

export default function TaskPage({ params }: { params: Promise<{ teamId: string; taskId: string }> }) {
  const { teamId, taskId } = use(params);
  const [task, setTask] = useState<Task | null>(null);
  const [form, setForm] = useState<Task | null>(null);
  const [ai, setAi] = useState<AiConfig>({ provider: "none", available: false, fake: false });
  const [history, setHistory] = useState<RequestRow[]>([]);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = async () => {
    const rows = await api<RequestRow[]>(`/api/tasks/${taskId}/advice`);
    setHistory(rows);
    return rows;
  };
  const open = async (id: string) => setAdvice(await api<Advice>(`/api/advice/${id}`));

  useEffect(() => {
    (async () => {
      try {
        setTask(await api<Task>(`/api/tasks/${taskId}`));
        api<{ ai: AiConfig }>("/api/config").then((c) => setAi(c.ai), () => {});
        const rows = await loadHistory();
        if (rows[0]) await open(rows[0].id);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [taskId]);

  // 서버가 아직 처리 중이면(같은 버튼을 두 번 누른 경우 등) 끝날 때까지 2초마다 다시 읽는다
  useEffect(() => {
    if (advice?.status !== "pending") return;
    const id = advice.id;
    const timer = setInterval(() => open(id).catch(() => clearInterval(timer)), 2000);
    return () => clearInterval(timer);
  }, [advice?.id, advice?.status]);

  const ask = async () => {
    setBusy(true); setError("");
    try {
      setAdvice(await api<Advice>(`/api/tasks/${taskId}/advice`, { body: { question, clientRequestId: crypto.randomUUID() } }));
      await loadHistory();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const saveTask = async () => {
    if (!form) return;
    try { setTask({ ...(await api<Task>(`/api/tasks/${taskId}`, { method: "PATCH", body: form })) }); setForm(null); }
    catch (e) { setError((e as Error).message); }
  };

  const react = async (itemId: string, reaction: "apply" | "hold" | "exclude", reason: string) => {
    try {
      await api(`/api/advice-items/${itemId}/reaction`, { body: { reaction, reason } });
      if (advice) await open(advice.id);
    } catch (e) { setError((e as Error).message); }
  };

  if (!task) return <main>{error ? <p className="error">{error}</p> : <p className="muted">불러오는 중…</p>}</main>;
  const keywordMode = advice?.provider === "none";

  return (
    <main>
      <p><a href={`/teams/${teamId}`}>← 팀 공간</a></p>
      {form ? (
        <div className="card">
          {(["title", "purpose", "audience", "constraints"] as const).map((k) => {
            const label = { title: "작업 제목", purpose: "목적", audience: "대상", constraints: "제약" }[k];
            return <p key={k}><input aria-label={label} placeholder={label} value={form[k]} maxLength={k === "title" ? 200 : 1000}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></p>;
          })}
          <div className="row"><button className="primary" onClick={saveTask}>저장</button><button onClick={() => setForm(null)}>취소</button></div>
        </div>
      ) : (
        <>
          <h1>{task.title}</h1>
          <p className="muted">{[task.purpose && `목적: ${task.purpose}`, task.audience && `대상: ${task.audience}`,
            task.constraints && `제약: ${task.constraints}`].filter(Boolean).join(" · ") || "목적·대상·제약이 비어 있습니다."}
            {" "}<button className="small" onClick={() => setForm(task)}>작업 수정</button></p>
        </>
      )}

      {ai.fake && <div className="banner">개발용 가짜 응답 모드입니다. 화면의 AI 결과는 실제 AI가 만든 것이 아닙니다.</div>}
      {ai.provider === "misconfigured" && (
        <div className="banner">AI 설정이 잘못되어 조언 기능을 쓸 수 없습니다. 운영자에게 알려 주세요.</div>
      )}
      {ai.provider === "none" && (
        <div className="banner">AI가 연결되지 않았습니다. 지금은 작업과 키워드가 겹치는 팀 메모만 찾아 보여주며,
          연결 이유·활용 제안·반론은 만들지 않습니다.</div>
      )}

      <div className="card">
        <textarea aria-label="질문" placeholder="(선택) 지금 고민하는 것. 예: 3장 슬라이드를 어떻게 구성할까?" value={question} maxLength={1000}
          onChange={(e) => setQuestion(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={busy} onClick={ask}>{busy ? "찾는 중…" : "팀 기억에서 조언 받기"}</button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {advice && <AdviceView advice={advice} keywordMode={keywordMode} onReact={react} />}

      {history.length > 1 && (
        <>
          <h2>이전 요청</h2>
          {history.map((h) => (
            <div key={h.id} className="row">
              <button className={`small ${advice?.id === h.id ? "on" : ""}`} onClick={() => open(h.id)}>
                {new Date(h.created_at).toLocaleString("ko-KR")} · {STATUS_TEXT[h.status] ?? h.status} · {h.item_count}개
                {h.provider === "none" ? " · AI 미사용" : h.provider === "fake" ? " · 가짜 응답" : ""}
              </button>
            </div>
          ))}
        </>
      )}
    </main>
  );
}

function AdviceView({ advice, keywordMode, onReact }: {
  advice: Advice; keywordMode: boolean; onReact: (id: string, r: "apply" | "hold" | "exclude", reason: string) => void;
}) {
  if (advice.status === "pending") return <p className="muted">처리 중… (자동으로 다시 확인합니다)</p>;
  if (advice.status === "failed") return <p className="error">{ERROR_TEXT[advice.error ?? "internal"] ?? ERROR_TEXT.internal}</p>;
  return (
    <div>
      {advice.status === "invalidated" && <p className="warn">{ERROR_TEXT[advice.error ?? "source_changed"] ?? ERROR_TEXT.source_changed}</p>}
      {advice.taskChanged && advice.status === "ok" && <p className="warn">이 조언 뒤에 작업 내용이 바뀌었습니다.</p>}
      {advice.status === "ok" && advice.emptyReason === "no_related_notes" && (
        <p className="muted">연결할 팀 자료가 부족합니다. 관련 메모가 없거나, 아직 공유된 메모가 적습니다.</p>
      )}
      {advice.status === "ok" && advice.emptyReason === "no_valid_items" && (
        <p className="muted">AI 응답에서 근거가 확인된 항목이 없어 아무것도 표시하지 않았습니다.</p>
      )}
      {advice.droppedCount > 0 && <p className="muted">근거를 확인할 수 없는 AI 항목 {advice.droppedCount}개를 버렸습니다.</p>}
      {advice.hints.map((h, i) => <p key={i} className="muted">💡 {h}</p>)}

      {SECTIONS.map((sec) => {
        const items = advice.items.filter((i) => i.section === sec.key);
        if (!items.length) return null;
        const label = keywordMode && sec.key === "direct" ? "키워드가 겹치는 팀 메모" : sec.label;
        const note = keywordMode && sec.key === "direct" ? "AI를 쓰지 않았습니다. 관련 여부는 직접 판단해 주세요." : sec.note;
        return (
          <div key={sec.key}>
            <div className={`section sec-${sec.key}`}><h3>{label}</h3><span className="muted">{note}</span></div>
            {items.map((it) => it.declinedEarlier
              ? <details key={it.id} className="card"><summary className="muted">이전에 {REACTION_TEXT[it.myReaction!.reaction]}한 제안 (펼치기)</summary>
                  <ItemCard item={it} onReact={onReact} /></details>
              : <div key={it.id} className="card"><ItemCard item={it} onReact={onReact} /></div>)}
          </div>
        );
      })}
    </div>
  );
}

function Quote({ text, quote }: { text: string; quote: string | null }) {
  const at = quote ? text.replace(/\s+/g, " ").indexOf(quote) : -1;
  if (!quote || at < 0) return <blockquote>{text}</blockquote>;
  const flat = text.replace(/\s+/g, " ");
  return <blockquote>{flat.slice(0, at)}<mark>{quote}</mark>{flat.slice(at + quote.length)}</blockquote>;
}

function ItemCard({ item, onReact }: { item: Item; onReact: (id: string, r: "apply" | "hold" | "exclude", reason: string) => void }) {
  const [reason, setReason] = useState(item.myReaction?.reason ?? "");
  if (item.hidden) return <p className="muted">근거 메모가 철회·수정·삭제되어 이 항목을 숨겼습니다.</p>;
  return (
    <>
      {item.keywordOnly && <span className="badge">키워드 일치 · AI 미사용</span>}
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{item.body}</p>
      {item.evidence.map((e) => e.available && (
        <details key={e.versionId} className="ev">
          <summary>근거: {e.authorName}의 메모</summary>
          <Quote text={e.text} quote={e.quote} />
          {e.summary && <p className="muted">작성자가 확인한 정리: {e.summary}</p>}
        </details>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        {(["apply", "hold", "exclude"] as const).map((r) => (
          <button key={r} className={`small ${item.myReaction?.reaction === r ? "on" : ""}`} onClick={() => onReact(item.id, r, reason)}>
            {REACTION_TEXT[r]}</button>
        ))}
        <input style={{ flex: 1, minWidth: 140 }} className="small" aria-label="반응 이유" placeholder="이유 (선택)" value={reason} maxLength={300}
          onChange={(e) => setReason(e.target.value)} />
      </div>
    </>
  );
}
