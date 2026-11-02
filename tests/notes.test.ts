import { describe, expect, it } from "vitest";
import { getPool } from "../src/lib/db.ts";
import {
  confirmVersion, createNote, deleteNote, editNote, getNote, listNotes, setRestatement, shareNote, withdrawNote,
} from "../src/lib/notes.ts";
import { searchCandidates } from "../src/lib/search.ts";
import { createTask } from "../src/lib/tasks.ts";
import { createTeam, joinTeam } from "../src/lib/teams.ts";
import { makeUser, restated, useCleanDb } from "./helpers.ts";

useCleanDb();

async function setup() {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  const team = await createTeam(alice, "A팀");
  await joinTeam(bob, team.inviteCode);
  return { alice, bob, teamId: team.id };
}

const search = (u: string, t: string, q: string) => searchCandidates(u, t, q, { requireExternalAi: false });

describe("작성자 확인과 공유", () => {
  it("확인하지 않은 메모는 공유할 수 없다", async () => {
    const { alice, teamId } = await setup();
    const { noteId, versionId } = await createNote(alice, teamId, { rawText: "숫자만 비교하면 오해할 수도" });
    await expect(shareNote(alice, noteId, versionId)).rejects.toMatchObject({ status: 409 });
  });

  it("화면에 보인 내용과 해시가 다르면 확인을 거부한다", async () => {
    const { alice, teamId } = await setup();
    const { noteId, versionId, contentHash } = await createNote(alice, teamId, { rawText: "조건이 달라 보임" });
    await setRestatement(alice, noteId, versionId, restated("측정 조건이 다를 수 있음"));
    // 정리 결과가 붙기 전의 해시로 확인 시도 → 거부
    await expect(
      confirmVersion(alice, noteId, versionId, { choice: "confirmed", expectedHash: contentHash }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("다른 사람은 남의 메모를 확인·공유·수정·철회·삭제할 수 없다", async () => {
    const { alice, bob, teamId } = await setup();
    const { noteId, versionId, contentHash } = await createNote(alice, teamId, { rawText: "앨리스 메모" });
    await expect(confirmVersion(bob, noteId, versionId, { choice: "raw_only", expectedHash: contentHash })).rejects.toMatchObject({ status: 404 });
    await expect(shareNote(bob, noteId, versionId)).rejects.toMatchObject({ status: 404 });
    await expect(editNote(bob, noteId, "고침")).rejects.toMatchObject({ status: 404 });
    await expect(withdrawNote(bob, noteId)).rejects.toMatchObject({ status: 404 });
    await expect(deleteNote(bob, noteId)).rejects.toMatchObject({ status: 404 });
  });

  it("초안은 다른 팀원에게 보이지 않는다 (존재 여부도)", async () => {
    const { alice, bob, teamId } = await setup();
    const { noteId } = await createNote(alice, teamId, { rawText: "아직 비공개 생각" });
    await expect(getNote(bob, noteId)).rejects.toMatchObject({ status: 404 });
    expect(await listNotes(bob, teamId)).toHaveLength(0);
    expect(await listNotes(alice, teamId)).toHaveLength(1);
  });

  it("AI 정리를 허용하지 않은 메모에는 정리 결과를 붙일 수 없고, 외부 AI 후보에서도 빠진다", async () => {
    const { alice, teamId } = await setup();
    const { noteId, versionId, contentHash } = await createNote(alice, teamId, { rawText: "측정 조건 다름", allowExternalAi: false });
    await expect(setRestatement(alice, noteId, versionId, restated("x"))).rejects.toMatchObject({ status: 409 });
    await confirmVersion(alice, noteId, versionId, { choice: "raw_only", expectedHash: contentHash });
    await shareNote(alice, noteId, versionId);
    expect(await searchCandidates(alice, teamId, "측정 조건", { requireExternalAi: false })).toHaveLength(1);
    expect(await searchCandidates(alice, teamId, "측정 조건", { requireExternalAi: true })).toHaveLength(0);
  });

  it("AI 정리를 사람이 고친 내용으로 확인할 수 있다", async () => {
    const { alice, teamId } = await setup();
    const { noteId, versionId } = await createNote(alice, teamId, { rawText: "비교가 이상함" });
    const { contentHash } = await setRestatement(alice, noteId, versionId, restated("A 방식이 우수하다"));
    await confirmVersion(alice, noteId, versionId, { choice: "edited", expectedHash: contentHash, editedSummary: "두 결과의 비교 방식에 의문이 있음" });
    const note = await getNote(alice, noteId);
    expect(note.versions[0]!.restated!.summary).toBe("두 결과의 비교 방식에 의문이 있음");
    expect(note.versions[0]!.intent_state).toBe("confirmed");
  });
});

describe("수정·철회·삭제 반영", () => {
  async function sharedNote(alice: string, teamId: string) {
    const { noteId, versionId, contentHash } = await createNote(alice, teamId, { rawText: "두 실험은 측정 조건이 달라 보임" });
    await confirmVersion(alice, noteId, versionId, { choice: "raw_only", expectedHash: contentHash });
    await shareNote(alice, noteId, versionId);
    return { noteId, versionId };
  }

  async function fakeAdvice(userId: string, teamId: string, versionId: string) {
    // 조언 생성 기능은 다음 단계. 여기서는 "이 버전을 근거로 쓴 조언"이 있다고 가정하고 행을 직접 만든다.
    const task = await createTask(userId, teamId, { title: "발표 구성" });
    const db = getPool();
    const r = await db.query(
      "insert into advice_requests (team_id, task_id, requester_id, task_version, context, status) values ($1,$2,$3,1,'ctx','ok') returning id",
      [teamId, task.id, userId],
    );
    await db.query("insert into advice_items (request_id, section, body, evidence_version_ids) values ($1, 'direct', 'b', $2)", [r.rows[0].id, [versionId]]);
    return r.rows[0].id as string;
  }
  const status = async (id: string) => (await getPool().query("select status from advice_requests where id = $1", [id])).rows[0]?.status;

  it("공유 메모가 검색된다", async () => {
    const { alice, bob, teamId } = await setup();
    await sharedNote(alice, teamId);
    const found = await search(bob, teamId, "측정 조건");
    expect(found).toHaveLength(1);
  });

  it("철회하면 즉시 검색에서 빠지고, 근거로 쓴 조언이 무효화된다", async () => {
    const { alice, bob, teamId } = await setup();
    const { noteId, versionId } = await sharedNote(alice, teamId);
    const adviceId = await fakeAdvice(bob, teamId, versionId);
    const res = await withdrawNote(alice, noteId);
    expect(res.invalidatedAdvice).toBe(1);
    expect(await search(bob, teamId, "측정 조건")).toHaveLength(0);
    expect(await status(adviceId)).toBe("invalidated");
    await expect(getNote(bob, noteId)).rejects.toMatchObject({ status: 404 });
  });

  it("공유 중 수정하면 공유가 내려가고, 새 버전은 다시 확인해야 공유된다", async () => {
    const { alice, bob, teamId } = await setup();
    const { noteId, versionId } = await sharedNote(alice, teamId);
    const adviceId = await fakeAdvice(bob, teamId, versionId);
    const edited = await editNote(alice, noteId, "두 실험은 측정 조건이 같았음. 내가 착각");
    expect(edited.unshared).toBe(true);
    expect(await search(bob, teamId, "측정 조건")).toHaveLength(0);
    expect(await status(adviceId)).toBe("invalidated");
    // 옛 버전을 다시 공유하려 해도 거부 (최신 버전만)
    await expect(shareNote(alice, noteId, versionId)).rejects.toMatchObject({ status: 409 });
    await expect(shareNote(alice, noteId, edited.versionId)).rejects.toMatchObject({ status: 409 });
    await confirmVersion(alice, noteId, edited.versionId, { choice: "raw_only", expectedHash: edited.contentHash });
    await shareNote(alice, noteId, edited.versionId);
    const found = await search(bob, teamId, "측정 조건");
    expect(found.map((c) => c.versionId)).toEqual([edited.versionId]);
  });

  it("삭제하면 원문이 DB에서 지워지고 근거 조언이 무효화된다", async () => {
    const { alice, bob, teamId } = await setup();
    const { noteId, versionId } = await sharedNote(alice, teamId);
    const adviceId = await fakeAdvice(bob, teamId, versionId);
    await deleteNote(alice, noteId);
    const left = await getPool().query("select count(*)::int as c from note_versions where note_id = $1", [noteId]);
    expect(left.rows[0].c).toBe(0);
    expect(await status(adviceId)).toBe("invalidated");
  });

  it("감사 로그에 메모 본문이 들어가지 않는다", async () => {
    const { alice, teamId } = await setup();
    await sharedNote(alice, teamId);
    const r = await getPool().query("select detail::text as d from audit_log");
    for (const row of r.rows) expect(row.d ?? "").not.toContain("측정 조건");
  });
});

describe("검색 품질 (키워드 기준선)", () => {
  it("관련 메모는 찾고, 무관한 메모는 찾지 않는다", async () => {
    const { alice, bob, teamId } = await setup();
    for (const raw of ["두 실험은 측정 조건이 달라 보임. 숫자만 비교하면 오해할 수도", "회의실 예약 목요일로 바꿈"]) {
      const { noteId, versionId, contentHash } = await createNote(alice, teamId, { rawText: raw });
      await confirmVersion(alice, noteId, versionId, { choice: "raw_only", expectedHash: contentHash });
      await shareNote(alice, noteId, versionId);
    }
    const found = await search(bob, teamId, "실험 결과 숫자 비교 슬라이드");
    expect(found.map((c) => c.rawText)).toEqual(["두 실험은 측정 조건이 달라 보임. 숫자만 비교하면 오해할 수도"]);
  });
});
