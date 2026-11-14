import { currentUserId, rateLimit, route } from "../../../../../../../lib/http.ts";
import { shareNote } from "../../../../../../../lib/notes.ts";
import { uuid } from "../../../../../../../lib/validate.ts";

export const POST = route<{ noteId: string; versionId: string }>(async (_req, p) => {
  const userId = await currentUserId();
  rateLimit(`share:${userId}`, 60, 60 * 60 * 1000);
  return shareNote(userId, uuid(p.noteId, "noteId"), uuid(p.versionId, "versionId"));
});
