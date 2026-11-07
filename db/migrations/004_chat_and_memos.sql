-- 004: 대화형 질문 + 메모 정리 공유
--
-- 대화(kind = 'chat'): 프로젝트 안에서 묻고 답하는 일반 AI 대화. 관련된 팀 공유 메모를 참고하지만
-- 답변에는 메모를 드러내지 않는다. 서버는 모델이 실제로 참고했다고 밝힌 메모(advice_items.evidence_version_ids)를
-- 기록해 두고, 그 메모가 철회·수정·삭제되면 그 답변만 숨기거나 지운다.
alter table advice_requests
  add column kind text not null default 'advice' check (kind in ('advice', 'chat'));
create index advice_requests_chat on advice_requests (task_id, requester_id, created_at) where kind = 'chat';

alter table advice_items drop constraint advice_items_section_check,
  add constraint advice_items_section_check
    check (section in ('direct', 'link_reason', 'ai_extension', 'extra', 'objection', 'answer'));

-- 메모의 출처: memo = '메모하기'로 쓴 개인 메모(공유하지 않음), summary = 메모를 골라 정리해 팀에 공유한 것
alter table notes
  add column origin text not null default 'memo' check (origin in ('memo', 'summary'));

-- 공유한 정리가 어떤 개인 메모에서 나왔는지. 어느 쪽이 지워져도 연결만 사라진다.
create table note_sources (
  note_id uuid not null references notes on delete cascade,
  source_note_id uuid not null references notes on delete cascade,
  primary key (note_id, source_note_id)
);
create index note_sources_source on note_sources (source_note_id);
