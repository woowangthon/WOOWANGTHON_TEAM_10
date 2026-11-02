import { currentUserId, route } from "../../../../../../../lib/http.ts";
import { shareNote } from "../../../../../../../lib/notes.ts";
import { uuid } from "../../../../../../../lib/validate.ts";

export const POST = route<{ noteId: string; versionId: string }>(async (_req, p) =>
  shareNote(await currentUserId(), uuid(p.noteId, "noteId"), uuid(p.versionId, "versionId")),
);
