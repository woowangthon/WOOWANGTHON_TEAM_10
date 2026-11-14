-- 다른 팀원에게 넘길 「AI만 참고」 메모의 전달용 정리.
--
-- 「AI만 참고」 메모는 작성자 본인이 물을 때만 원문을 모델에 넘긴다. 다른 팀원이 물을 때는 원문 대신
-- 이 표의 정리(전할 사실 + 후보를 고르는 기준)만 넘긴다. 정리는 메모 버전마다 한 번 만들어 저장한다.
-- 메모를 지우면 버전과 함께 지워진다(on delete cascade).
--
-- 이전 코드와의 호환: 새 표만 추가하므로 이전 코드는 영향이 없다.
create table note_relays (
  version_id uuid primary key references note_versions (id) on delete cascade,
  relay_version text not null,
  facts jsonb not null default '[]'::jsonb,
  considerations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- 이전 지시문으로 만든 대화 기억(요약)에는 다른 팀원의 「AI만 참고」 내용이 질문자의 선호처럼 적혀 있을 수 있다.
-- 요약은 다음 질문 때 대화에서 다시 만들어지므로 모두 지운다. 이 마이그레이션이 적용된 뒤 새 코드가 올라오기 전에
-- 이전 코드가 만든 요약도 가려낼 수 있게, 요약을 만든 지시문 버전을 함께 적는다(이전 코드는 이 열을 쓰지 않아 null 로 남는다).
alter table chat_memories add column prompt_version text;
delete from chat_memories;
