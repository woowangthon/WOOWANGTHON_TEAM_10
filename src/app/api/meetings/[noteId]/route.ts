import { currentUserId, readJson, route } from "../../../../lib/http.ts";
import { updateMeeting } from "../../../../lib/meetings.ts";
import { uuid } from "../../../../lib/validate.ts";

/** 회의록 고치기 (쓴 사람만). 본문: { title, date, text } */
export const PATCH = route<{ noteId: string }>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return updateMeeting(userId, uuid(p.noteId, "noteId"), { title: b.title, date: b.date, text: b.text });
});
