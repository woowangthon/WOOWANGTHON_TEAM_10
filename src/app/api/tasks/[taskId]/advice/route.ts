import { listAdviceRequests, requestAdvice } from "../../../../../lib/advice.ts";
import { getProvider } from "../../../../../lib/ai/providers.ts";
import { currentUserId, rateLimit, readJson, route } from "../../../../../lib/http.ts";
import { uuid } from "../../../../../lib/validate.ts";

type P = { taskId: string };
// 모델 호출 2회(판정+생성)가 20~30초 걸릴 수 있다. 배포 플랫폼의 기본 함수 시간 제한(예: 10초)을 넘지 않게 늘린다.
export const maxDuration = 60;

export const GET = route<P>(async (_req, p) => listAdviceRequests(await currentUserId(), uuid(p.taskId, "taskId")));
export const POST = route<P>(async (req, p) => {
  const userId = await currentUserId();
  rateLimit(`advice:${userId}`, 30, 60 * 60 * 1000); // 비용 상한
  const b = await readJson(req);
  return requestAdvice(userId, uuid(p.taskId, "taskId"), { question: b.question, clientRequestId: b.clientRequestId }, getProvider());
});
