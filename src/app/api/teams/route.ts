import { currentUserId, readJson, route } from "../../../lib/http.ts";
import { createTeam, listMyTeams } from "../../../lib/teams.ts";

export const GET = route(async () => listMyTeams(await currentUserId()));
export const POST = route(async (req) => {
  const userId = await currentUserId();
  const body = await readJson(req);
  return createTeam(userId, body.name);
});
