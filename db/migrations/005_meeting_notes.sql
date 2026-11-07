-- 005: 회의록
-- 팀원끼리 회의한 내용을 기록해 두면, 대화할 때 AI 가 다른 팀 지식처럼(출처를 드러내지 않고) 참고한다.
-- 회의록은 메모의 한 종류(notes.origin = 'meeting')로 저장해 권한·철회·삭제·AI 참고 끄기·조용한 다시 쓰기 규칙을 그대로 따른다.
alter table notes drop constraint notes_origin_check,
  add constraint notes_origin_check check (origin in ('memo', 'summary', 'meeting'));

-- 회의 제목과 회의한 날짜 (회의록에만 씀)
alter table notes add column title text check (title is null or length(title) between 1 and 200);
alter table notes add column meeting_date date;

-- 회의록은 메모보다 길다. 길이 상한은 앱에서 종류별로 건다(메모 2000자, 회의록 10000자)
alter table note_versions drop constraint note_versions_raw_text_check,
  add constraint note_versions_raw_text_check check (length(raw_text) between 1 and 10000);

create index notes_team_meetings on notes (team_id, meeting_date desc) where origin = 'meeting';
