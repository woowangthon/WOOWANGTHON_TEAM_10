import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { setVisibility } from "../../../../../lib/memos.ts";
import { uuid } from "../../../../../lib/validate.ts";

/** 공유 범위 바꾸기 (작성자만). 본문: { visibility: "team" | "ai_only" } */
export const PATCH = route<{ noteId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return setVisibility(userId, uuid(p.noteId, "noteId"), { visibility: body.visibility });
});
