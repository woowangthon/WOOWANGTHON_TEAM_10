import { getProvider } from "../../../../../../../lib/ai/providers.ts";
import { currentUserId, rateLimit, route } from "../../../../../../../lib/http.ts";
import { restateNote } from "../../../../../../../lib/restate.ts";
import { uuid } from "../../../../../../../lib/validate.ts";

export const POST = route<{ noteId: string; versionId: string }>(async (_req, p) => {
  const userId = await currentUserId();
  rateLimit(`restate:${userId}`, 30, 60 * 60 * 1000); // 비용 상한
  return restateNote(userId, uuid(p.noteId, "noteId"), uuid(p.versionId, "versionId"), getProvider());
});
