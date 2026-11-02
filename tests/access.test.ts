import { describe, expect, it } from "vitest";
import { createNote, confirmVersion, getNote, listNotes, shareNote } from "../src/lib/notes.ts";
import { searchCandidates } from "../src/lib/search.ts";
import { createTask, listTasks } from "../src/lib/tasks.ts";
import { createTeam, getInviteCode, joinTeam, leaveTeam } from "../src/lib/teams.ts";
import { makeUser, useCleanDb } from "./helpers.ts";

useCleanDb();

async function sharedNote(userId: string, teamId: string, raw: string) {
  const { noteId, versionId, contentHash } = await createNote(userId, teamId, { rawText: raw });
  await confirmVersion(userId, noteId, versionId, { choice: "raw_only", expectedHash: contentHash });
  await shareNote(userId, noteId, versionId);
  return noteId;
}

describe("팀 경계", () => {
  it("다른 팀 사람은 메모·목록·작업·검색 어디에도 접근할 수 없다 (404)", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const teamA = await createTeam(alice, "A팀");
    await createTeam(mallory, "M팀");
    const noteId = await sharedNote(alice, teamA.id, "두 실험은 측정 조건이 달라 보임");
    await createTask(alice, teamA.id, { title: "발표 구성" });

    await expect(getNote(mallory, noteId)).rejects.toMatchObject({ status: 404 });
    await expect(listNotes(mallory, teamA.id)).rejects.toMatchObject({ status: 404 });
    await expect(listTasks(mallory, teamA.id)).rejects.toMatchObject({ status: 404 });
    await expect(createNote(mallory, teamA.id, { rawText: "끼어들기" })).rejects.toMatchObject({ status: 404 });
    await expect(
      searchCandidates(mallory, teamA.id, "측정 조건", { requireExternalAi: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("초대 코드로 가입하면 접근 가능, 탈퇴하면 다시 차단된다", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const team = await createTeam(alice, "A팀");
    const noteId = await sharedNote(alice, team.id, "회의는 목요일");

    await joinTeam(bob, team.inviteCode);
    expect((await getNote(bob, noteId)).versions).toHaveLength(1);

    await leaveTeam(bob, team.id);
    await expect(getNote(bob, noteId)).rejects.toMatchObject({ status: 404 });
  });

  it("초대 코드는 팀장만 볼 수 있다", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const team = await createTeam(alice, "A팀");
    await joinTeam(bob, team.inviteCode);
    expect(await getInviteCode(alice, team.id)).toBe(team.inviteCode);
    await expect(getInviteCode(bob, team.id)).rejects.toMatchObject({ status: 404 });
  });
});
