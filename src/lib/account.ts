// 회원 탈퇴: 팀에 공유된 회의록을 뺀 이 사람의 정보를 모두 지운다.
//
// 지우는 것
//  - 계정 행(이메일·이름·비밀번호 해시)
//  - 이 사람이 쓴 메모·공유한 정리·철회해 둔 회의록 전부(모든 버전). 그 내용을 반영한 답변은 무효화하고 본문을 지운다
//    (메모 하나를 삭제할 때와 같은 규칙: src/lib/notes.ts deleteNote)
// 남기는 것 (사용자 결정: 회의록은 팀 기록)
//  - 팀에 공유 중인 회의록. 이 사람이 처음 썼으면 작성자를 비우고("탈퇴한 사용자"), 이 사람이 고친 버전은 고친 사람을 비운다.
//    회의록 내용은 그대로 두고, AI 도 계속 참고한다.
//  - 이 사람의 조언 요청·조언·반응 (요청한 사람에게만 보이는 개인 기록)
//  - 활동 중인 팀원이 아무도 남지 않는 팀 (팀 전체 자료 포함)
// 남는 것
//  - 다른 팀원이 계속 쓰는 팀과 그 팀의 프로젝트. 프로젝트의 "만든 사람" 은 비운다
//  - audit_log 의 사용자 ID(무작위 UUID)와 행동 종류·시각. 이메일·이름·본문은 원래 넣지 않는다
import type { PoolClient } from "pg";
import { verifyPassword } from "./auth.ts";
import { audit, withTx } from "./db.ts";
import { AppError, unauthorized } from "./errors.ts";
import { invalidateAdviceForNote, purgeAdviceForNote } from "./notes.ts";
import { leaveTeamInTx } from "./teams.ts";

export async function deleteAccount(userId: string, input: { password: unknown }) {
  if (typeof input.password !== "string" || !input.password) {
    throw new AppError(400, "password_required", "본인 확인을 위해 비밀번호를 입력해 주세요.");
  }
  const password = input.password;
  return withTx(async (tx) => {
    // 같은 계정의 동시 탈퇴·동시 요청이 꼬이지 않게 계정 행을 잠근다
    const u = await tx.query("select password_hash from users where id = $1 for update", [userId]);
    if (!u.rowCount) throw unauthorized();
    if (!(await verifyPassword(password, u.rows[0].password_hash))) {
      throw new AppError(403, "wrong_password", "비밀번호가 올바르지 않습니다.");
    }

    const teamsLeft = await leaveAllTeams(tx, userId);
    const notesDeleted = await deleteAllNotes(tx, userId);

    await tx.query("delete from reactions where user_id = $1", [userId]);
    await tx.query("delete from advice_requests where requester_id = $1", [userId]);
    await tx.query("update tasks set created_by = null where created_by = $1", [userId]);
    await tx.query("update note_versions set confirmed_by = null where confirmed_by = $1", [userId]);

    // 활동 중인 팀원이 남지 않은 팀은 아무도 볼 수 없는 자료만 남으므로 통째로 지운다
    const emptied = await tx.query(
      `delete from teams t where t.id = any($1::uuid[])
         and not exists (select 1 from memberships m where m.team_id = t.id and m.status = 'active' and m.user_id <> $2)
       returning t.id`,
      [teamsLeft, userId],
    );

    await tx.query("delete from users where id = $1", [userId]);
    await audit(tx, userId, "user.delete", userId, {
      teamsLeft: teamsLeft.length,
      teamsDeleted: emptied.rowCount ?? 0,
      notesDeleted,
    });
    return { deleted: true, notesDeleted, teamsDeleted: emptied.rowCount ?? 0 };
  });
}

/** 활동 중인 모든 팀에서 나간다. 유일한 팀장이면 팀 나가기와 같은 규칙으로 팀장을 넘긴다. */
async function leaveAllTeams(tx: PoolClient, userId: string): Promise<string[]> {
  const r = await tx.query(
    "select team_id from memberships where user_id = $1 and status = 'active' order by team_id",
    [userId],
  );
  const ids = r.rows.map((x) => x.team_id as string);
  for (const teamId of ids) await leaveTeamInTx(tx, userId, teamId);
  return ids;
}

/**
 * 이 사람이 쓴 메모를 모든 팀(이미 나간 팀 포함)에서 지운다. 팀에 공유 중인 회의록은 지우지 않고 작성자만 비운다.
 */
async function deleteAllNotes(tx: PoolClient, userId: string): Promise<number> {
  const r = await tx.query(
    `select id from notes where author_id = $1 and not (origin = 'meeting' and share_state = 'shared') order by id for update`,
    [userId],
  );
  for (const { id } of r.rows) {
    await invalidateAdviceForNote(tx, id);
    await purgeAdviceForNote(tx, id);
  }
  if (r.rowCount) await tx.query("delete from notes where id = any($1::uuid[])", [r.rows.map((x) => x.id)]);
  // 남기는 회의록: 작성자를 비운다 (고친 사람은 note_versions.confirmed_by 의 외래키 규칙으로 비워진다)
  await tx.query("update notes set author_id = null where author_id = $1 and origin = 'meeting' and share_state = 'shared'", [userId]);
  return r.rowCount ?? 0;
}
