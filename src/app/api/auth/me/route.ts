import { getUser } from "../../../../lib/auth.ts";
import { unauthorized } from "../../../../lib/errors.ts";
import { currentUserId, route } from "../../../../lib/http.ts";

export const GET = route(async () => {
  const user = await getUser(await currentUserId());
  if (!user) throw unauthorized();
  return { id: user.id, email: user.email, displayName: user.display_name };
});
