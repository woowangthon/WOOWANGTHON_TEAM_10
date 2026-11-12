-- 메모 저장의 중복 방지: 응답을 받지 못한 화면이 같은 저장 요청을 다시 보내도 메모가 하나만 생기게 한다.
-- 화면이 저장마다 만든 식별자(client_request_id)를 함께 보내고, 같은 사람의 같은 식별자는 한 번만 저장한다
-- (대화·조언 요청의 advice_requests.client_request_id 와 같은 방식).
-- 열 추가뿐이라 이전 코드도 그대로 동작한다.
alter table notes add column client_request_id uuid;
create unique index notes_author_client_request on notes (author_id, client_request_id) where client_request_id is not null;
