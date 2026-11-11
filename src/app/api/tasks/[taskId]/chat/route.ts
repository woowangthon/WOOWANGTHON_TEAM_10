import { getProvider } from "../../../../../lib/ai/providers.ts";
import { askInProject, listChat, retryChatTurn } from "../../../../../lib/chat.ts";
import { currentUserId, rateLimit, readJson, route } from "../../../../../lib/http.ts";
import { uuid } from "../../../../../lib/validate.ts";

type P = { taskId: string };
// 모델 호출 1회. 느린 응답에 대비해 함수 시간 제한을 늘린다.
export const maxDuration = 60;

export const GET = route<P>(async (_req, p) => listChat(await currentUserId(), uuid(p.taskId, "taskId")));
export const POST = route<P>(async (req, p) => {
  const userId = await currentUserId();
  rateLimit(`advice:${userId}`, 60, 60 * 60 * 1000); // 비용 상한
  const b = await readJson(req);
  // { retry: 질문 ID }: 실패한 질문을 같은 자리에서 다시 답한다 (새 질문을 만들지 않는다)
  if (b.retry !== undefined) return retryChatTurn(userId, uuid(p.taskId, "taskId"), uuid(b.retry, "retry"), getProvider());
  return askInProject(userId, uuid(p.taskId, "taskId"), { question: b.question, clientRequestId: b.clientRequestId }, getProvider());
});
