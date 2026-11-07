import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { shareSummary } from "../../../../../lib/memos.ts";
import { uuid } from "../../../../../lib/validate.ts";

/** 작성자가 확정한 정리를 팀에 공유 */
export const POST = route<{ teamId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return shareSummary(userId, uuid(p.teamId, "teamId"), {
    text: body.text,
    sourceNoteIds: body.sourceNoteIds,
    allowExternalAi: body.allowExternalAi,
  });
});
