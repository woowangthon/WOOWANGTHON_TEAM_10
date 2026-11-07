import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { createMeeting, listMeetings } from "../../../../../lib/meetings.ts";
import { uuid } from "../../../../../lib/validate.ts";

type P = { teamId: string };
export const GET = route<P>(async (_req, p) => listMeetings(await currentUserId(), uuid(p.teamId, "teamId")));
/** 회의록 추가. 본문: { title, date: "YYYY-MM-DD", text, allowExternalAi? } */
export const POST = route<P>(async (req, p) => {
  const userId = await currentUserId();
  const b = await readJson(req);
  return createMeeting(userId, uuid(p.teamId, "teamId"), { title: b.title, date: b.date, text: b.text, allowExternalAi: b.allowExternalAi });
});
