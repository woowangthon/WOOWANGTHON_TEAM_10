import { currentUserId, readJson, route } from "../../../../lib/http.ts";
import { deleteNote, editNote, getNote } from "../../../../lib/notes.ts";
import { uuid } from "../../../../lib/validate.ts";

type P = { noteId: string };
export const GET = route<P>(async (_req, p) => getNote(await currentUserId(), uuid(p.noteId, "noteId")));
export const PATCH = route<P>(async (req, p) => {
  const userId = await currentUserId();
  return editNote(userId, uuid(p.noteId, "noteId"), (await readJson(req)).rawText);
});
export const DELETE = route<P>(async (_req, p) => deleteNote(await currentUserId(), uuid(p.noteId, "noteId")));
