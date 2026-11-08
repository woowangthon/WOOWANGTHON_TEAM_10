-- 007: 사용자별 대화 기억
-- 프로젝트 대화는 최근 몇 턴만 그대로 모델에 넘기고, 그보다 오래된 대화는 요약해 둔다(사용자·프로젝트마다 하나, 본인만 씀).
-- 요약에는 팀 지식 내용이 섞일 수 있으므로, 요약에 들어간 대화가 받았던 지식 버전을 함께 기록해 둔다.
-- 그 지식이 철회·수정·삭제되거나 AI 참고에서 빠지면 요약을 지우고 다음 질문 때 그 내용 없이 다시 만든다(notes.ts).
create table chat_memories (
  task_id uuid not null references tasks on delete cascade,
  user_id uuid not null references users on delete cascade,
  summary text not null check (length(summary) between 1 and 4000),
  -- 요약에 접어 넣은 마지막 대화의 시각
  covered_until timestamptz not null,
  -- 요약에 접어 넣은 대화들이 모델에 건넸던 지식 버전 (철회·삭제 반영용)
  input_version_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index chat_memories_inputs on chat_memories using gin (input_version_ids);
