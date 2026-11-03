import { currentUserId, route } from "../../../../lib/http.ts";
import { getTeam } from "../../../../lib/teams.ts";
import { uuid } from "../../../../lib/validate.ts";

export const GET = route<{ teamId: string }>(async (_req, p) => getTeam(await currentUserId(), uuid(p.teamId, "teamId")));
