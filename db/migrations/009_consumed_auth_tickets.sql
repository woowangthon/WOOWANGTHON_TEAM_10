-- 코드 교체·계정 삭제 뒤에도 만료 전 발급권을 다시 쓸 수 없도록 소모 이력을 남긴다.
-- 발급권/코드 원문이나 사용자·팀 식별자는 보관하지 않는다.
create table consumed_auth_tickets (
  ticket_hash text primary key check (ticket_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null
);
create index consumed_auth_tickets_expiry on consumed_auth_tickets (expires_at);
