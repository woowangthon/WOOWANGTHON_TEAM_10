import { getProvider } from "../../../../../../lib/ai/providers.ts";
import { refreshStale } from "../../../../../../lib/chat.ts";
import { currentUserId, rateLimit, route } from "../../../../../../lib/http.ts";
import { uuid } from "../../../../../../lib/validate.ts";

// 바뀐 지식에 기댄 답변을 최대 3개 다시 쓴다 (모델 호출 3~6회)
export const maxDuration = 60;

export const POST = route<{ taskId: string }>(async (_req, p) => {
  const userId = await currentUserId();
  rateLimit(`chat-refresh:${userId}`, 60, 60 * 60 * 1000); // 비용 상한
  return refreshStale(userId, uuid(p.taskId, "taskId"), getProvider());
});
