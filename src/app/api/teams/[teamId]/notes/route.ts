import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { createNote, listNotes } from "../../../../../lib/notes.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const GET = route<{ teamId: string }>(async (_req, p) =>
  listNotes(await currentUserId(), uuid(p.teamId, "teamId")),
);
export const POST = route<{ teamId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return createNote(userId, uuid(p.teamId, "teamId"), { rawText: body.rawText, allowExternalAi: body.allowExternalAi });
});
