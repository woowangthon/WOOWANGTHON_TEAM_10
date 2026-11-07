-- 005: 회의록
-- 팀원끼리 회의한 내용을 기록해 두면, 대화할 때 AI 가 다른 팀 지식처럼(출처를 드러내지 않고) 참고한다.
-- 회의록은 메모의 한 종류(notes.origin = 'meeting')로 저장해 철회·삭제·AI 참고 끄기·조용한 다시 쓰기 규칙을 그대로 따른다.
-- 회의록은 팀 기록이다: 팀원 누구나 고칠 수 있고(버전마다 고친 사람 = note_versions.confirmed_by),
-- 쓴 사람이 탈퇴해도 공유된 회의록은 남는다(author_id 를 비움).
alter table notes drop constraint notes_origin_check,
  add constraint notes_origin_check check (origin in ('memo', 'summary', 'meeting'));

-- 현재 회의 제목과 회의한 날짜 (회의록에만 씀)
alter table notes add column title text check (title is null or length(title) between 1 and 200);
alter table notes add column meeting_date date;

-- 버전별 제목·날짜: 누가 무엇을 고쳤는지 보여주기 위해 버전마다 남긴다
alter table note_versions add column title text check (title is null or length(title) between 1 and 200);
alter table note_versions add column meeting_date date;

-- 탈퇴한 사람이 쓴 공유 회의록은 작성자를 비우고 남긴다. 회의록이 아닌 메모는 작성자가 반드시 있어야 한다.
alter table notes alter column author_id drop not null;
alter table notes add constraint notes_author_required check (author_id is not null or origin = 'meeting');

-- 회의록은 메모보다 길다. 길이 상한은 앱에서 종류별로 건다(메모 2000자, 회의록 10000자)
alter table note_versions drop constraint note_versions_raw_text_check,
  add constraint note_versions_raw_text_check check (length(raw_text) between 1 and 10000);

create index notes_team_meetings on notes (team_id, meeting_date desc) where origin = 'meeting';
