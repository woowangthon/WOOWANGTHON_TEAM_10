-- 003: 회원 탈퇴
-- 탈퇴 처리 순서는 src/lib/account.ts 가 정한다(메모 삭제 → 조언 본문 제거 → 익명화 → 계정 삭제).
-- 아래 규칙은 그 코드가 빠뜨린 참조가 있어도 탈퇴가 외래키 오류로 막히지 않게 하는 안전망이다.
-- notes.author_id 는 일부러 그대로 둔다: 메모는 근거로 쓴 조언 본문까지 지워야 하므로 반드시 코드로 지운다.

-- 작업은 팀 자산: 만든 사람이 탈퇴해도 남고, 만든 사람 표시만 비운다
alter table tasks alter column created_by drop not null;
alter table tasks drop constraint tasks_created_by_fkey,
  add constraint tasks_created_by_fkey foreign key (created_by) references users on delete set null;

-- 확인 기록: 메모는 작성자만 확인하므로 보통 메모와 함께 지워지지만, 남는 경우 확인자만 비운다
alter table note_versions drop constraint note_versions_confirmed_by_fkey,
  add constraint note_versions_confirmed_by_fkey foreign key (confirmed_by) references users on delete set null;

-- 조언 요청과 반응은 요청한 사람에게만 보이는 개인 기록이므로 함께 지운다
alter table advice_requests drop constraint advice_requests_requester_id_fkey,
  add constraint advice_requests_requester_id_fkey foreign key (requester_id) references users on delete cascade;
alter table reactions drop constraint reactions_user_id_fkey,
  add constraint reactions_user_id_fkey foreign key (user_id) references users on delete cascade;
