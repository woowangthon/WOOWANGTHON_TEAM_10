// 조언 생성에 쓸 후보 메모 검색 (키워드 기준선: pg_trgm).
// 권한·상태 필터를 "검색보다 먼저" 적용한다 (원안 §7.2-2).
// 의미 검색(임베딩)은 이후 단계에서 같은 후보 풀 위에 추가한다.
import { requireMembership } from "./access.ts";
import { getPool } from "./db.ts";
import { text } from "./validate.ts";

export type Candidate = {
  versionId: string;
  noteId: string;
  rawText: string;
  summary: string | null;
  conditions: string[];
  kind: string | null;
  score: number;
};

/**
 * 공유 중 + 작성자 확인 완료 + 색인 완료인 현재 버전만 후보로 삼는다.
 * requireExternalAi: 외부 AI 에 보낼 후보라면 AI 처리를 허용한 메모만.
 */
export async function searchCandidates(
  userId: string,
  teamId: string,
  queryInput: unknown,
  opts: { requireExternalAi: boolean; limit?: number },
): Promise<Candidate[]> {
  const query = text(queryInput, "검색어", { min: 1, max: 2000 });
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const db = getPool();
  await requireMembership(db, userId, teamId);
  const r = await db.query(
    `select v.id as version_id, n.id as note_id, v.raw_text, v.restated, v.kind,
            word_similarity($2, v.search_text) as score
     from notes n
     join note_versions v on v.id = n.current_version_id and v.team_id = n.team_id
     where n.team_id = $1
       and n.share_state = 'shared'
       and v.intent_state in ('confirmed', 'raw_only')
       and v.index_state = 'ready'
       and ($3::boolean = false or n.allow_external_ai)
       and word_similarity($2, v.search_text) > 0.05
     order by score desc, n.updated_at desc
     limit $4`,
    [teamId, query, opts.requireExternalAi, limit],
  );
  return r.rows.map((row) => ({
    versionId: row.version_id,
    noteId: row.note_id,
    rawText: row.raw_text,
    summary: row.restated?.summary ?? null,
    conditions: row.restated?.conditions ?? [],
    kind: row.kind,
    score: Number(row.score),
  }));
}
