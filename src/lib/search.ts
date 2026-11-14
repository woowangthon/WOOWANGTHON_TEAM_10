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
  allowExternalAi: boolean;
  /** memo | summary | meeting */
  origin: string;
  /** 회의록 제목·날짜 (회의록만) */
  title: string | null;
  meetingDate: string | null;
  /** 팀원에게 보이지 않고 AI 만 참고하는 메모 */
  aiOnly: boolean;
  /** 쓴 사람 (회의록은 탈퇴하면 null). 모델·화면에는 넘기지 않는다: 질문자 본인의 것인지 가리는 데에만 쓴다 */
  authorId: string | null;
  /** 이 버전을 쓴 날짜 (한국 시간, YYYY-MM-DD). '내일'·'다음 주' 같은 말의 기준 */
  writtenOn: string | null;
  /** 작업 맥락의 키워드 중 이 메모에 나타난 개수 */
  hits: number;
  score: number;
};

export type SearchOptions = {
  /** 외부 AI 에 보낼 후보라면 AI 처리를 허용한 메모만 */
  requireExternalAi: boolean;
  limit?: number;
  /** 공유 메모가 이 개수 이하인 작은 팀이면 키워드가 안 겹쳐도 전부 후보로 (AI 판정용). 0 이면 끔 */
  includeAllIfAtMost?: number;
  /**
   * 'AI만 참고' 메모(팀원에게 보이지 않음)도 후보로. 화면에 메모 원문을 보여주지 않는 프로젝트 대화에서만 켠다.
   * 근거 원문을 보여주는 이전 조언 흐름에서는 끈다(팀원에게 원문이 보이므로).
   */
  includeAiOnly?: boolean;
  /**
   * 질문한 사람. 주면 "다른 사람의 'AI만 참고' 메모"가 후보에서 차지하는 수를 maxOtherAiOnly 로 제한한다.
   * 'AI만 참고' 메모는 팀장에게도 보이지 않으므로, 누군가 많이 만들어 공개 메모·회의록을 후보에서 밀어내거나
   * 작은 팀의 "전부 넘기기"를 끄지 못하게 하기 위해서다. 본인의 'AI만 참고' 메모는 제한하지 않는다.
   */
  viewerId?: string;
  maxOtherAiOnly?: number;
};

/** 다른 사람의 'AI만 참고' 메모가 한 번의 후보에서 차지할 수 있는 기본 최대 수 */
export const MAX_OTHER_AI_ONLY = 10;

/** 권한 확인이 끝난 뒤 내부에서 부르는 검색. */
export async function findCandidates(teamId: string, query: string, opts: SearchOptions): Promise<Candidate[]> {
  const tokens = keywordTokens(query);
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const r = await getPool().query(
    `with eligible as (
       select v.id as version_id, n.id as note_id, v.raw_text, v.restated, v.kind, v.search_text, n.updated_at,
              n.origin, n.title, n.meeting_date::text as meeting_date, n.visibility, n.author_id,
              ($7::uuid is not null and n.visibility = 'ai_only' and n.author_id is distinct from $7::uuid) as other_private,
              to_char(v.created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as written_on,
              n.allow_external_ai
       from notes n
       join note_versions v on v.id = n.current_version_id and v.team_id = n.team_id
       where n.team_id = $1
         and n.share_state = 'shared'
         and v.intent_state in ('confirmed', 'raw_only')
         and v.index_state = 'ready'
         and ($3::boolean = false or n.allow_external_ai)
         and ($6::boolean or n.visibility = 'team')
     ), scored as (
       select e.*,
              (select count(*) from unnest($2::text[]) w where word_similarity(w, e.search_text) >= 0.5)::int as hits
       from eligible e
     ), ranked as (
       -- 다른 사람의 'AI만 참고' 메모는 그들끼리 순위를 매겨 정해진 수까지만 남긴다
       select s.*, row_number() over (partition by s.other_private order by s.hits desc, s.updated_at desc, s.version_id) as rn
       from scored s
     ), capped as (
       select r.*, count(*) over () as total from ranked r where not r.other_private or r.rn <= $8
     )
     select * from capped
     where hits >= 1 or ($5::int > 0 and total <= $5)
     order by hits desc, updated_at desc
     limit $4`,
    [teamId, tokens, opts.requireExternalAi, limit, opts.includeAllIfAtMost ?? 0, opts.includeAiOnly ?? false, opts.viewerId ?? null,
     Math.max(0, opts.maxOtherAiOnly ?? MAX_OTHER_AI_ONLY)],
  );
  return r.rows.map((row) => ({
    versionId: row.version_id,
    noteId: row.note_id,
    rawText: row.raw_text,
    summary: row.restated?.summary ?? null,
    conditions: row.restated?.conditions ?? [],
    kind: row.kind,
    allowExternalAi: row.allow_external_ai,
    origin: row.origin,
    title: row.title ?? null,
    meetingDate: row.meeting_date ?? null,
    aiOnly: row.visibility === "ai_only",
    authorId: (row.author_id as string | null) ?? null,
    writtenOn: row.written_on ?? null,
    hits: Number(row.hits),
    score: tokens.length ? row.hits / tokens.length : 0,
  }));
}

/** 사용자 요청으로 검색할 때: 팀 가입 여부부터 확인한다. */
export async function searchCandidates(userId: string, teamId: string, queryInput: unknown, opts: SearchOptions) {
  const query = text(queryInput, "검색어", { min: 1, max: 4000 });
  await requireMembership(getPool(), userId, teamId);
  return findCandidates(teamId, query, opts);
}
