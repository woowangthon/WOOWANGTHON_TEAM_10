import { describeProvider } from "../../../lib/ai/providers.ts";
import { currentUserId, route } from "../../../lib/http.ts";

// 화면이 "AI 연결 여부"를 알기 위한 경로. 비밀값은 돌려주지 않는다.
export const GET = route(async () => {
  await currentUserId();
  return { ai: describeProvider() };
});
