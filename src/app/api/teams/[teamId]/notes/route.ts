import { currentUserId, rateLimit, readJson, route } from "../../../../../lib/http.ts";
import { createNote, listNotes } from "../../../../../lib/notes.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const GET = route<{ teamId: string }>(async (_req, p) =>
  listNotes(await currentUserId(), uuid(p.teamId, "teamId")),
);
export const POST = route<{ teamId: string }>(async (req, p) => {
  const userId = await currentUserId();
  rateLimit(`memo-create:${userId}`, 120, 60 * 60 * 1000); // 대량 생성 방지 (개수 상한은 limits.ts)
  const body = await readJson(req);
  return createNote(userId, uuid(p.teamId, "teamId"), { rawText: body.rawText, allowExternalAi: body.allowExternalAi, clientRequestId: body.clientRequestId });
});
