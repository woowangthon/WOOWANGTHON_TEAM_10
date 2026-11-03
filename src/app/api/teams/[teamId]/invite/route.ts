import { currentUserId, route } from "../../../../../lib/http.ts";
import { getInviteCode, rotateInviteCode } from "../../../../../lib/teams.ts";
import { uuid } from "../../../../../lib/validate.ts";

type P = { teamId: string };
export const GET = route<P>(async (_req, p) => ({
  inviteCode: await getInviteCode(await currentUserId(), uuid(p.teamId, "teamId")),
}));
// 초대 코드 재발급 (팀장만)
export const POST = route<P>(async (_req, p) => rotateInviteCode(await currentUserId(), uuid(p.teamId, "teamId")));
