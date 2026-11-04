import { getAdvice } from "../../../../lib/advice.ts";
import { currentUserId, route } from "../../../../lib/http.ts";
import { uuid } from "../../../../lib/validate.ts";

export const GET = route<{ requestId: string }>(async (_req, p) => getAdvice(await currentUserId(), uuid(p.requestId, "requestId")));
