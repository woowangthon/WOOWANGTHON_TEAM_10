import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { reviseShared } from "../../../../../lib/memos.ts";
import { uuid } from "../../../../../lib/validate.ts";

/** 공유한 정리를 고쳐서 다시 공유 */
export const POST = route<{ noteId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return reviseShared(userId, uuid(p.noteId, "noteId"), { text: body.text });
});
