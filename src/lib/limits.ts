// 메모·공유 지식의 개수 상한.
//
// 왜 필요한가: 초대 코드를 아는 사람은 누구나 팀에 들어와 메모를 만들 수 있고, 'AI만 참고' 메모는 팀장에게도 보이지 않는다.
// 상한이 없으면 보이지 않는 메모를 대량으로 만들어 (1) 공개 메모·회의록을 모델 입력에서 밀어내거나
// (2) 지식 검색을 느리게 해 다른 팀원의 질문이 시간 초과로 실패하게 만들 수 있다.
// 검색 쪽의 몫 제한(search.ts MAX_OTHER_AI_ONLY)과 함께 쓴다.
import type { PoolClient } from "pg";
import { AppError } from "./errors.ts";

/** 한 사람이 한 팀에 둘 수 있는 개인 메모(공유 전 포함) */
export const MAX_MEMOS_PER_AUTHOR = 300;
/** 한 사람이 한 팀에 공유해 둘 수 있는 지식(회의록 제외) */
export const MAX_SHARED_PER_AUTHOR = 60;
/** 그중 'AI만 참고' */
export const MAX_AI_ONLY_PER_AUTHOR = 15;
/** 한 팀에 공유된 지식 전체(회의록 제외) */
export const MAX_SHARED_PER_TEAM = 300;
/** 한 팀의 'AI만 참고' 전체 */
export const MAX_AI_ONLY_PER_TEAM = 60;
/** 한 팀의 회의록 */
export const MAX_MEETINGS_PER_TEAM = 200;

const tooMany = (msg: string) => new AppError(409, "limit_reached", msg);

// 상한 검사는 잠금 없이 센다. 동시에 온 요청끼리는 상한을 조금 넘길 수 있지만(요청 횟수 제한이 그 폭을 묶는다),
// 메모 행을 먼저 잠그는 경로와 팀 행을 먼저 잠그는 경로(참여·나가기)가 서로를 기다리는 일을 만들지 않기 위해서다.

/** 개인 메모를 새로 만들기 전에 */
export async function assertCanCreateMemo(tx: PoolClient, userId: string, teamId: string) {
  const r = await tx.query("select count(*)::int as c from notes where team_id = $1 and author_id = $2 and origin = 'memo'", [teamId, userId]);
  if (r.rows[0].c >= MAX_MEMOS_PER_AUTHOR)
    throw tooMany(`한 팀에 둘 수 있는 내 메모는 ${MAX_MEMOS_PER_AUTHOR}개까지입니다. 쓰지 않는 메모를 지운 뒤 다시 시도해 주세요.`);
}

/**
 * 지식을 공유 상태로 만들기 전에(새 공유, 철회한 것을 다시 공유, 공개 범위 바꾸기). exceptNoteId 는 지금 다루는 메모로,
 * 이미 공유 중이면 세지 않는다.
 */
export async function assertCanShare(tx: PoolClient, userId: string, teamId: string, visibility: "team" | "ai_only", exceptNoteId: string | null = null) {
  const r = await tx.query(
    `select count(*) filter (where author_id = $2)::int as mine,
            count(*) filter (where author_id = $2 and visibility = 'ai_only')::int as mine_ai_only,
            count(*) filter (where visibility = 'ai_only')::int as team_ai_only,
            count(*)::int as team
     from notes
     where team_id = $1 and share_state = 'shared' and origin <> 'meeting' and ($3::uuid is null or id <> $3)`,
    [teamId, userId, exceptNoteId],
  );
  const c = r.rows[0] as { mine: number; mine_ai_only: number; team_ai_only: number; team: number };
  if (c.mine >= MAX_SHARED_PER_AUTHOR)
    throw tooMany(`한 사람이 한 팀에 공유할 수 있는 지식은 ${MAX_SHARED_PER_AUTHOR}개까지입니다. 쓰지 않는 공유를 철회하거나 지운 뒤 다시 시도해 주세요.`);
  if (c.team >= MAX_SHARED_PER_TEAM)
    throw tooMany(`한 팀에 공유할 수 있는 지식은 ${MAX_SHARED_PER_TEAM}개까지입니다.`);
  if (visibility === "ai_only") {
    if (c.mine_ai_only >= MAX_AI_ONLY_PER_AUTHOR)
      throw tooMany(`「AI만 참고」로 공유할 수 있는 지식은 한 사람당 ${MAX_AI_ONLY_PER_AUTHOR}개까지입니다. 쓰지 않는 것을 철회하거나 지운 뒤 다시 시도해 주세요.`);
    // 팀 전체 상한은 누가 얼마나 썼는지 드러내지 않는 문구로 알린다 (다른 사람의 'AI만 참고'가 있다는 사실 자체는 정책상 비밀이 아니다)
    if (c.team_ai_only >= MAX_AI_ONLY_PER_TEAM)
      throw tooMany("이 팀에는 「AI만 참고」 지식을 더 둘 수 없습니다. 팀에 공유로 바꾸거나 나중에 다시 시도해 주세요.");
  }
}

/** 회의록을 새로 만들기 전에 */
export async function assertCanCreateMeeting(tx: PoolClient, teamId: string) {
  const r = await tx.query("select count(*)::int as c from notes where team_id = $1 and origin = 'meeting'", [teamId]);
  if (r.rows[0].c >= MAX_MEETINGS_PER_TEAM) throw tooMany(`한 팀에 둘 수 있는 회의록은 ${MAX_MEETINGS_PER_TEAM}개까지입니다.`);
}
