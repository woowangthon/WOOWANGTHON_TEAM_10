// 후보 메모 검색 (키워드 기준선: pg_trgm).
// 권한·상태 필터를 "검색보다 먼저" 적용한다 (원안 §7.2-2).
// 의미 검색(임베딩)은 이후 단계에서 같은 후보 풀 위에 추가한다.
import { requireMembership } from "./access.ts";
import { getPool } from "./db.ts";
import { keywordTokens } from "./keywords.ts";
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

export type SearchOptions = {
  /** 외부 AI 에 보낼 후보라면 AI 처리를 허용한 메모만 */
  requireExternalAi: boolean;
  limit?: number;
  /** 공유 메모가 이 개수 이하인 작은 팀이면 키워드가 안 겹쳐도 전부 후보로 (AI 판정용). 0 이면 끔 */
  includeAllIfAtMost?: number;
};

/** 권한 확인이 끝난 뒤 내부에서 부르는 검색. */
export async function findCandidates(teamId: string, query: string, opts: SearchOptions): Promise<Candidate[]> {
  const tokens = keywordTokens(query);
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const r = await getPool().query(
    `with eligible as (
       select v.id as version_id, n.id as note_id, v.raw_text, v.restated, v.kind, v.search_text, n.updated_at
       from notes n
       join note_versions v on v.id = n.current_version_id and v.team_id = n.team_id
       where n.team_id = $1
         and n.share_state = 'shared'
         and v.intent_state in ('confirmed', 'raw_only')
         and v.index_state = 'ready'
         and ($3::boolean = false or n.allow_external_ai)
     ), scored as (
       select e.*,
              (select count(*) from unnest($2::text[]) w where word_similarity(w, e.search_text) >= 0.5)::int as hits,
              count(*) over () as total
       from eligible e
     )
     select * from scored
     where hits >= 1 or ($5::int > 0 and total <= $5)
     order by hits desc, updated_at desc
     limit $4`,
    [teamId, tokens, opts.requireExternalAi, limit, opts.includeAllIfAtMost ?? 0],
  );
  return r.rows.map((row) => ({
    versionId: row.version_id,
    noteId: row.note_id,
    rawText: row.raw_text,
    summary: row.restated?.summary ?? null,
    conditions: row.restated?.conditions ?? [],
    kind: row.kind,
    score: tokens.length ? row.hits / tokens.length : 0,
  }));
}

/** 사용자 요청으로 검색할 때: 팀 가입 여부부터 확인한다. */
export async function searchCandidates(userId: string, teamId: string, queryInput: unknown, opts: SearchOptions) {
  const query = text(queryInput, "검색어", { min: 1, max: 4000 });
  await requireMembership(getPool(), userId, teamId);
  return findCandidates(teamId, query, opts);
}
