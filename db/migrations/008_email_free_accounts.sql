-- 이메일 없이 개인용 로그인 코드로 시작하는 계정. 기존 계정과 UUID 권한은 보존한다.
alter table users alter column email drop not null;
alter table users alter column password_hash drop not null;
alter table users add column login_code_hash text unique;
alter table users add constraint users_auth_method_check check (
  (email is not null and password_hash is not null and login_code_hash is null)
  or
  (email is null and password_hash is null and login_code_hash is not null and login_code_hash ~ '^[a-f0-9]{64}$')
);
