import { currentUserId, readJson, route } from "../../../../../../../lib/http.ts";
import { confirmVersion } from "../../../../../../../lib/notes.ts";
import { uuid } from "../../../../../../../lib/validate.ts";

export const POST = route<{ noteId: string; versionId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return confirmVersion(userId, uuid(p.noteId, "noteId"), uuid(p.versionId, "versionId"), {
    choice: b.choice,
    expectedHash: b.expectedHash,
    editedSummary: b.editedSummary,
  });
});
