// 전달용 정리: 다른 팀원의 'AI만 참고' 메모를 답변 모델에 넘길 때 원문 대신 쓰는 형태.
//
// 왜 필요한가
//  - 'AI만 참고' 메모의 원문을 그대로 넘기면, 답변 모델이 쓴 사람의 바람·걱정·질문을 지금 질문한 사람의 전제로
//    바꿔 말하거나("관광객이 아예 없는 곳은 아니야"), 메모 속 질문에 대신 답한다.
//  - 초대 코드를 아는 사람은 누구나 팀장에게도 보이지 않는 'AI만 참고' 메모를 만들 수 있다. 원문을 넘기면 그 안의
//    지시·비밀·개인 사정이 다른 팀원의 답변을 만드는 모델에 그대로 닿는다.
//
// 지키는 것
//  - 다른 팀원의 'AI만 참고' 원문은 답변 모델에 넘기지 않는다. 이 모듈이 만든 정리(전할 사실 + 고려할 점)만 넘긴다.
//  - 정리는 메모 버전마다 한 번 만들어 저장한다(지시문 버전이 바뀌면 다시 만든다).
//  - 정리를 만들지 못했거나 넘길 것이 없는 메모는 이번 답변에 쓰지 않는다(원문으로 대신하지 않는다).
import { callAi } from "./advice.ts";
import { RELAY_VERSION } from "./ai/prompts.ts";
import type { AiProvider, Relay } from "./ai/types.ts";
import { validateRelayOutput } from "./ai/validate-output.ts";
import { getPool } from "./db.ts";

/** 한 번의 질문에서 새로 만들 정리의 최대 수. 넘는 메모는 이번 답변에서 빠지고 다음 질문 때 만든다 */
const MAX_NEW_RELAYS = 12;

type Source = { versionId: string; rawText: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 주어진 메모 버전들의 전달용 정리. 저장된 것이 있으면 그것을 쓰고, 없으면 모델로 만들어 저장한다.
 * 돌려주는 맵에 없는 버전은 이번 답변에 쓰면 안 된다. 넘길 것이 없는 메모는 빈 정리로 들어 있다.
 */
export async function relaysFor(provider: AiProvider, sources: Source[]): Promise<Map<string, Relay>> {
  const out = new Map<string, Relay>();
  if (!sources.length) return out;
  const db = getPool();
  const cached = await db.query(
    "select version_id, facts, considerations from note_relays where version_id = any($1::uuid[]) and relay_version = $2",
    [sources.map((s) => s.versionId), RELAY_VERSION],
  );
  for (const r of cached.rows) out.set(r.version_id as string, { facts: strings(r.facts), considerations: strings(r.considerations) });

  const missing = sources.filter((s) => !out.has(s.versionId)).slice(0, MAX_NEW_RELAYS);
  if (!missing.length) return out;
  try {
    const refs = new Map<string, Source>(missing.map((s, i) => [`P${i + 1}`, s]));
    const raw = await callAi((signal) => provider.relay({ memos: [...refs].map(([ref, s]) => ({ ref, text: s.rawText })) }, { signal }));
    const made = validateRelayOutput(raw, new Set(refs.keys()));
    for (const [ref, relay] of made) {
      const versionId = refs.get(ref)!.versionId;
      // 그 사이 메모가 지워졌다면(버전이 없음) 저장하지 않는다: 외래키 위반 대신 건너뛴다
      const saved = await db.query(
        `insert into note_relays (version_id, relay_version, facts, considerations)
         select $1, $2, $3::jsonb, $4::jsonb where exists (select 1 from note_versions where id = $1)
         on conflict (version_id) do update set relay_version = excluded.relay_version, facts = excluded.facts,
           considerations = excluded.considerations, created_at = now()
         returning version_id`,
        [versionId, RELAY_VERSION, JSON.stringify(relay.facts), JSON.stringify(relay.considerations)],
      );
      if (saved.rowCount) out.set(versionId, relay);
    }
  } catch (err) {
    // 정리를 만들지 못하면 그 메모들 없이 답한다 (대화는 막지 않는다)
    console.error("relay failed", (err as Error)?.name);
  }
  return out;
}

export const isEmptyRelay = (r: Relay) => r.facts.length === 0 && r.considerations.length === 0;
