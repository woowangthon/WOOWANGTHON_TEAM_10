import { currentUserId, readJson, route } from "../../../../lib/http.ts";
import { getTask, updateTask } from "../../../../lib/tasks.ts";
import { uuid } from "../../../../lib/validate.ts";

type P = { taskId: string };
export const GET = route<P>(async (_req, p) => {
  const t = await getTask(await currentUserId(), uuid(p.taskId, "taskId"));
  return { id: t.id, teamId: t.team_id, title: t.title, purpose: t.purpose, audience: t.audience, constraints: t.constraints, version: t.version };
});
export const PATCH = route<P>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return updateTask(userId, uuid(p.taskId, "taskId"), { title: b.title, purpose: b.purpose, audience: b.audience, constraints: b.constraints });
});
