import { reactToItem } from "../../../../../lib/advice.ts";
import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const POST = route<{ itemId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return reactToItem(userId, uuid(p.itemId, "itemId"), { reaction: b.reaction, reason: b.reason });
});
