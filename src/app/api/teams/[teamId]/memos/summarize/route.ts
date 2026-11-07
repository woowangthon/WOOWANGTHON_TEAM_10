import { getProvider } from "../../../../../../lib/ai/providers.ts";
import { currentUserId, rateLimit, readJson, route } from "../../../../../../lib/http.ts";
import { summarizeMemos } from "../../../../../../lib/memos.ts";
import { uuid } from "../../../../../../lib/validate.ts";

export const maxDuration = 60;

/** 고른 내 메모만 AI 로 정리한 초안을 돌려준다 (저장하지 않음) */
export const POST = route<{ teamId: string }>(async (req, p) => {
  const userId = await currentUserId();
  rateLimit(`restate:${userId}`, 30, 60 * 60 * 1000); // 비용 상한
  const body = await readJson(req);
  return summarizeMemos(userId, uuid(p.teamId, "teamId"), { noteIds: body.noteIds }, getProvider());
});
