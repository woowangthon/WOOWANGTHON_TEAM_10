-- 001: 계정·팀·작업·메모(버전)·조언·반응·감사 로그
-- 설계: docs/구현_구체화.md §3. 의미 검색(pgvector) 컬럼은 이후 마이그레이션에서 추가.
create extension if not exists pg_trgm;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null check (length(display_name) between 1 and 40),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table memberships (
  team_id uuid not null references teams on delete cascade,
  user_id uuid not null references users on delete cascade,
  role text not null default 'member' check (role in ('member','lead')),
  status text not null default 'active' check (status in ('active','left')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  created_by uuid not null references users,
  title text not null check (length(title) between 1 and 200),
  purpose text not null default '',
  audience text not null default '',
  constraints text not null default '',
  version int not null default 1,
  created_at timestamptz not null default now(),
  unique (id, team_id)
);

create table notes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  author_id uuid not null references users,
  current_version_id uuid,
  share_state text not null default 'draft'
    check (share_state in ('draft','shared','withdrawn','deleted')),
  allow_external_ai boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, team_id)
);

create table note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null,
  team_id uuid not null,
  version int not null,
  raw_text text not null check (length(raw_text) between 1 and 2000),
  restated jsonb,
  intent_state text not null default 'unconfirmed'
    check (intent_state in ('unconfirmed','confirmed','raw_only')),
  kind text check (kind in ('proposal','guess','question','objection','decision')),
  fact_state text not null default 'unverified'
    check (fact_state in ('unverified','evidence_attached','reviewed')),
  content_hash text not null,
  confirmed_by uuid references users,
  confirmed_at timestamptz,
  search_text text,
  index_state text not null default 'pending' check (index_state in ('pending','ready','failed')),
  created_at timestamptz not null default now(),
  unique (note_id, version),
  unique (id, team_id),
  -- 버전은 반드시 같은 팀의 메모에 속함 (팀 경계 제약)
  foreign key (note_id, team_id) references notes (id, team_id) on delete cascade
);

alter table notes add constraint notes_current_version_fk
  foreign key (current_version_id, team_id) references note_versions (id, team_id)
  deferrable initially deferred;

create index note_versions_search_trgm on note_versions using gin (search_text gin_trgm_ops);
create index notes_team_state on notes (team_id, share_state);

create table advice_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  task_id uuid not null,
  requester_id uuid not null references users,
  task_version int not null,
  context text not null,
  status text not null default 'pending' check (status in ('pending','ok','invalidated','failed')),
  model text,
  prompt_version text,
  usage jsonb,
  created_at timestamptz not null default now(),
  foreign key (task_id, team_id) references tasks (id, team_id) on delete cascade
);

create table advice_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references advice_requests on delete cascade,
  section text not null check (section in ('direct','link_reason','ai_extension','extra','objection')),
  body text not null,
  evidence_version_ids uuid[] not null default '{}',
  proposal_key text
);
create index advice_items_evidence on advice_items using gin (evidence_version_ids);

create table reactions (
  task_id uuid not null references tasks on delete cascade,
  proposal_key text not null,
  user_id uuid not null references users,
  reaction text not null check (reaction in ('apply','hold','exclude')),
  reason text,
  evidence_version_ids uuid[] not null,
  created_at timestamptz not null default now(),
  primary key (task_id, proposal_key, user_id)
);

-- 운영 기록: 본문(메모 원문·조언)은 넣지 않는다
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  target uuid,
  detail jsonb
);
