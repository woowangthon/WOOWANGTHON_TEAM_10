import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { createTask, listTasks } from "../../../../../lib/tasks.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const GET = route<{ teamId: string }>(async (_req, p) =>
  listTasks(await currentUserId(), uuid(p.teamId, "teamId")),
);
export const POST = route<{ teamId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return createTask(userId, uuid(p.teamId, "teamId"), { title: b.title, purpose: b.purpose, audience: b.audience, constraints: b.constraints });
});
