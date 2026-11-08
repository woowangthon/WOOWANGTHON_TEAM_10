-- 006: 'AI만 참고' 공유
-- 공유할 때 두 가지 중 고른다.
--   team    : 팀원도 보고, AI 도 대화할 때 참고한다 (기존 방식)
--   ai_only : 팀원은 볼 수 없고(작성자만 봄), AI 만 대화할 때 참고한다
-- ai_only 는 정리해 공유한 메모(origin = 'summary')에만 쓰며, AI 참고를 끈 채로 둘 수 없다(그러면 아무도 쓰지 않는 기록이 됨).
alter table notes add column visibility text not null default 'team' check (visibility in ('team', 'ai_only'));
alter table notes add constraint notes_ai_only_scope check (visibility = 'team' or (origin = 'summary' and allow_external_ai));
