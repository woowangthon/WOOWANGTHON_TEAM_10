import { currentUserId, route } from "../../../../../lib/http.ts";
import { leaveTeam } from "../../../../../lib/teams.ts";
import { uuid } from "../../../../../lib/validate.ts";

export const POST = route<{ teamId: string }>(async (_req, p) => leaveTeam(await currentUserId(), uuid(p.teamId, "teamId")));
