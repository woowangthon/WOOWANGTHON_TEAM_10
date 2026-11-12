// 계정 시작·로그인 코드 변경 요청이 실패했을 때 화면이 무엇을 안내할지 정한다.
//
// 이 요청들은 "응답을 받지 못했지만 서버에서는 끝났을 수 있는" 경우가 있다(연결 끊김, 서버 오류). 그때는
// 보관한 코드로 계정을 열어 확인하라고 안내한다. 하지만 서버가 분명히 거절한 요청(틀린 초대 코드, 형식 오류,
// 요청 제한)까지 "완료됐을 수 있다"고 안내하면 사용자는 무엇을 고쳐야 하는지 알 수 없다.
import { ApiError } from "./api-client.ts";

export type StartFailure = {
  message: string;
  /** 완료 여부를 알 수 없음: 응답을 받지 못했거나 서버 오류 */
  uncertain: boolean;
  /** "보관한 코드로 계정 열기"를 보여 줄지 */
  canRecover: boolean;
};

export function startFailure(error: unknown): StartFailure {
  if (error instanceof ApiError) {
    if (error.status >= 500) return { message: error.message, uncertain: true, canRecover: true };
    // 409: 이 코드로 이미 시작했다. 완료된 것이 확실하므로 보관한 코드로 들어가면 된다
    return { message: error.message, uncertain: false, canRecover: error.status === 409 };
  }
  const message = error instanceof TypeError
    ? "요청을 마치지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."
    : error instanceof Error ? error.message : "요청을 마치지 못했습니다.";
  return { message, uncertain: true, canRecover: true };
}
