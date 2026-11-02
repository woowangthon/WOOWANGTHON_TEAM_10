// 메모 정리(재진술) 흐름 (원안 §7.1).
//  1) 잠금 없이 사전 확인  2) 트랜잭션 밖에서 AI 호출(오래 걸릴 수 있으므로)
//  3) 저장할 때 "그 사이 메모가 바뀌지 않았는지" 해시로 다시 확인
// AI 가 실패해도 원문 초안은 그대로 남는다. 정리 결과는 작성자가 확인하기 전까지 공유되지 않는다.
import { requireMembership } from "./access.ts";
import { aiUnavailable } from "./ai/providers.ts";
import { AiTimeout, aiTimeoutMs, withTimeout } from "./ai/timeout.ts";
import type { AiProvider } from "./ai/types.ts";
import { getPool } from "./db.ts";
import { AppError, conflict, notFound } from "./errors.ts";
import { parseRestated, setRestatement, type Restated } from "./notes.ts";
import { restatementWarnings } from "./restate-check.ts";

export async function restateNote(userId: string, noteId: string, versionId: string, provider: AiProvider) {
  if (!provider.isAi) throw aiUnavailable();
  const db = getPool();
  const r = await db.query(
    `select n.author_id, n.team_id, n.share_state, n.allow_external_ai,
            v.raw_text, v.intent_state, v.content_hash, v.version,
            (select max(x.version) from note_versions x where x.note_id = n.id) as latest
     from notes n join note_versions v on v.note_id = n.id
     where n.id = $1 and v.id = $2`,
    [noteId, versionId],
  );
  const row = r.rows[0];
  if (!row || row.author_id !== userId || row.share_state === "deleted") throw notFound();
  await requireMembership(db, userId, row.team_id);
  // 외부 AI 처리를 허용하지 않은 메모는 모델에 보내지 않는다
  if (!row.allow_external_ai) throw conflict("이 메모는 AI 정리를 허용하지 않았습니다.");
  if (row.version !== row.latest || row.intent_state !== "unconfirmed")
    throw conflict("최신 미확인 버전만 정리할 수 있습니다.");

  let output: unknown;
  try {
    output = await withTimeout(provider.restate({ rawText: row.raw_text }), aiTimeoutMs());
  } catch (err) {
    if (err instanceof AiTimeout)
      throw new AppError(504, "ai_timeout", "AI 응답이 늦어 중단했습니다. 원문은 그대로 남아 있습니다.");
    console.error("restate failed", (err as Error)?.name);
    throw new AppError(502, "ai_error", "AI 정리에 실패했습니다. 원문은 그대로 남아 있습니다.");
  }

  let restated: Restated;
  try {
    restated = parseRestated(output);
  } catch {
    throw new AppError(502, "invalid_ai_output", "AI 정리 결과의 형식이 올바르지 않아 버렸습니다. 원문은 그대로 남아 있습니다.");
  }

  const saved = await setRestatement(userId, noteId, versionId, restated, { expectedHash: row.content_hash });
  return { ...saved, restated, warnings: restatementWarnings(row.raw_text, restated) };
}
