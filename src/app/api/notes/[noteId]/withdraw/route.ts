import { currentUserId, route } from "../../../../../lib/http.ts";
import { withdrawNote } from "../../../../../lib/notes.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const POST = route<{ noteId: string }>(async (_req, p) => withdrawNote(await currentUserId(), uuid(p.noteId, "noteId")));
