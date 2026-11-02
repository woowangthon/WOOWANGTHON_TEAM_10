import { currentUserId, route } from "../../../../../lib/http.ts";
import { getInviteCode } from "../../../../../lib/teams.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const GET = route<{ teamId: string }>(async (_req, p) => ({
  inviteCode: await getInviteCode(await currentUserId(), uuid(p.teamId, "teamId")),
}));
