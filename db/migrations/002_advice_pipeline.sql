-- 002: 조언 파이프라인 뼈대
alter table advice_requests
  add column provider text not null default 'none',
  add column client_request_id uuid,
  add column question text not null default '',
  -- 모델(또는 화면)에 넘긴 메모 버전. 이 중 하나라도 철회·수정·삭제되면 요청 전체를 무효화한다.
  add column input_version_ids uuid[] not null default '{}',
  add column candidate_count int not null default 0,
  add column dropped_count int not null default 0,
  add column empty_reason text,
  add column error text,
  add column finished_at timestamptz;

create unique index advice_requests_client_req
  on advice_requests (requester_id, client_request_id) where client_request_id is not null;
create index advice_requests_task on advice_requests (task_id, requester_id, created_at desc);
create index advice_requests_inputs on advice_requests using gin (input_version_ids);

alter table advice_items
  add column position int not null default 0,
  add column action text,
  add column quotes jsonb not null default '[]',
  -- 근거 메모가 삭제되면 본문·인용을 지우고 true 로 표시
  add column purged boolean not null default false;

alter table reactions
  add column advice_item_id uuid references advice_items on delete set null,
  add column updated_at timestamptz not null default now();
