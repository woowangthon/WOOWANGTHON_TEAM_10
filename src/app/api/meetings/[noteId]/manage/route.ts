import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { manageMeeting } from "../../../../../lib/meetings.ts";
import { uuid } from "../../../../../lib/validate.ts";

/** 공유 철회·다시 공유·삭제·AI 참고 켜고 끄기 (처음 쓴 사람이나 팀장). 본문: { action, allowExternalAi? } */
export const POST = route<{ noteId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return manageMeeting(userId, uuid(p.noteId, "noteId"), { action: b.action, allowExternalAi: b.allowExternalAi });
});
