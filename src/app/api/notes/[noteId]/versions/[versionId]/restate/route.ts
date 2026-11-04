import { getProvider } from "../../../../../../../lib/ai/providers.ts";
import { currentUserId, rateLimit, route } from "../../../../../../../lib/http.ts";
import { restateNote } from "../../../../../../../lib/restate.ts";
import { uuid } from "../../../../../../../lib/validate.ts";

// 모델 호출 2회(판정+생성)가 20~30초 걸릴 수 있다. 배포 플랫폼의 기본 함수 시간 제한(예: 10초)을 넘지 않게 늘린다.
export const maxDuration = 60;

export const POST = route<{ noteId: string; versionId: string }>(async (_req, p) => {
  const userId = await currentUserId();
  rateLimit(`restate:${userId}`, 30, 60 * 60 * 1000); // 비용 상한
  return restateNote(userId, uuid(p.noteId, "noteId"), uuid(p.versionId, "versionId"), getProvider());
});
