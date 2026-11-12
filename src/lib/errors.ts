// 사용자에게 돌려줄 수 있는 오류. 내부 정보(SQL, 스택)는 메시지에 넣지 않는다.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = () => new AppError(404, "not_found", "찾을 수 없습니다.");
export const inviteNotFound = () =>
  new AppError(404, "invite_not_found", "초대 코드를 찾을 수 없습니다. 팀장에게 받은 코드를 다시 확인해 주세요.");
export const forbidden = () => new AppError(403, "forbidden", "권한이 없습니다.");
export const badRequest = (msg: string) => new AppError(400, "bad_request", msg);
export const conflict = (msg: string) => new AppError(409, "conflict", msg);
export const unauthorized = () => new AppError(401, "unauthorized", "로그인이 필요합니다.");
