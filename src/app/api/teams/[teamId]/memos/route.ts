import { currentUserId, readJson, route } from "../../../../../lib/http.ts";
import { listMemos } from "../../../../../lib/memos.ts";
import { createNote } from "../../../../../lib/notes.ts";
import { uuid } from "../../../../../lib/validate.ts";

type P = { teamId: string };
/** 메모 보기: 내 메모 + 팀에 공유된 정리 */
export const GET = route<P>(async (_req, p) => listMemos(await currentUserId(), uuid(p.teamId, "teamId")));
/** 메모하기: 나만 보는 메모로 저장 */
export const POST = route<P>(async (req, p) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return createNote(userId, uuid(p.teamId, "teamId"), { rawText: body.text, allowExternalAi: true });
});
