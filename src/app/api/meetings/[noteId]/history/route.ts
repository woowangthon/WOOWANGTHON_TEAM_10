import { currentUserId, route } from "../../../../../lib/http.ts";
import { meetingHistory } from "../../../../../lib/meetings.ts";
import { uuid } from "../../../../../lib/validate.ts";

/** 회의록 수정 기록 (버전마다 고친 사람·시각·내용) */
export const GET = route<{ noteId: string }>(async (_req, p) => meetingHistory(await currentUserId(), uuid(p.noteId, "noteId")));
