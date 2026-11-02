import { listAdviceRequests, requestAdvice } from "../../../../../lib/advice.ts";
import { getProvider } from "../../../../../lib/ai/providers.ts";
import { currentUserId, rateLimit, readJson, route } from "../../../../../lib/http.ts";
import { uuid } from "../../../../../lib/validate.ts";

type P = { taskId: string };
export const GET = route<P>(async (_req, p) => listAdviceRequests(await currentUserId(), uuid(p.taskId, "taskId")));
export const POST = route<P>(async (req, p) => {
  const userId = await currentUserId();
  rateLimit(`advice:${userId}`, 30, 60 * 60 * 1000); // 비용 상한
  const b = await readJson(req);
  return requestAdvice(userId, uuid(p.taskId, "taskId"), { question: b.question, clientRequestId: b.clientRequestId }, getProvider());
});
