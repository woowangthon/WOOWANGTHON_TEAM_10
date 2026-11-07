import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { setAiReference } from "../../../../../lib/memos.ts";
import { uuid } from "../../../../../lib/validate.ts";

/** 공유한 지식을 AI 가 대화에서 참고할지 켜고 끈다. 본문: { allowExternalAi: boolean } */
export const PATCH = route<{ noteId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return setAiReference(userId, uuid(p.noteId, "noteId"), { allowExternalAi: body.allowExternalAi });
});
