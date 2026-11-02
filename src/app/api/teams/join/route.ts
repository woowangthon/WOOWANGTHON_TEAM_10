import { currentUserId, readJson, route } from "../../../../lib/http.ts";
import { joinTeam } from "../../../../lib/teams.ts";

export const POST = route(async (req) => {
  const userId = await currentUserId();
  return joinTeam(userId, (await readJson(req)).inviteCode);
});
