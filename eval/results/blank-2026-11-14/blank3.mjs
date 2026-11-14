// 백지 검증: 지시문을 고칠 때 한 번도 쓰지 않은 시나리오로, 다른 팀원의 「AI만 참고」가 질문자의 답변에
// 뜬금없이 나타나는지 본다. 고치기 전 서버와 고친 서버에 똑같이 돌려 JSON 으로 남긴다.
//   node blank.mjs <BASE> <out.json> <시나리오 번호들, 예: 0,1,2>
import fs from 'node:fs';
const [BASE, OUT, WHICH] = process.argv.slice(2);
class Client {
  constructor(){ this.cookies = new Map(); }
  async start(body){ const p = await this.call('POST','/api/auth/prepare',{}); this.code = p.data.loginCode; return this.call('POST','/api/auth/signup',{...body, registrationTicket: p.data.registrationTicket}); }
  async call(method, path, body){
    const headers = { Origin: BASE }; if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    if (body!==undefined) headers['Content-Type']='application/json';
    const res = await fetch(BASE+path,{method,headers,body: body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair]=c.split(';'); const i=pair.indexOf('='); this.cookies.set(pair.slice(0,i).trim(), pair.slice(i+1).trim()); }
    const t = await res.text(); let data={}; try{ data = t?JSON.parse(t):{}; }catch{ data={raw:t.slice(0,200)}; }
    return { status: res.status, data };
  }
}
const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0,200)}`); return r; };

// 각 시나리오: 세 사람이 「AI만 참고」로 메모를 남긴다. 네 번째 사람(관찰자)은 메모가 하나도 없다.
// via: 'summarize' = 운영에서처럼 메모하기 → AI 정리 → 공유, 'direct' = 직접 쓴 정리를 바로 공유
export const SCENARIOS = JSON.parse(fs.readFileSync(new URL('./set3.json', import.meta.url), 'utf8'));
const OBSERVER = '관찰자';

async function run(sc) {
  const names = Object.keys(sc.members); const C = {}; const all = [];
  for (const n of [...names, OBSERVER]) { C[n] = new Client(); all.push(C[n]); }
  const rows = [];
  try {
    const s = ok(await C[names[0]].start({ displayName: names[0], teamName: `백지3 ${sc.name} ${Date.now().toString(36)}` }), '가입');
    const teamId = s.data.team.id;
    const inviteCode = ok(await C[names[0]].call('GET', `/api/teams/${teamId}/invite`), '초대').data.inviteCode;
    for (const n of [...names.slice(1), OBSERVER]) ok(await C[n].start({ displayName: n, inviteCode }), '참여');
    const taskId = ok(await C[names[0]].call('POST', `/api/teams/${teamId}/tasks`, { ...sc.project, audience: '', constraints: '' }), '프로젝트').data.id;
    const shared = {};
    for (const n of names) {
      if (sc.via === 'summarize') {
        const ids = []; for (const t of sc.members[n]) ids.push(ok(await C[n].call('POST', `/api/teams/${teamId}/memos`, { text: t }), '메모').data.noteId);
        const sum = ok(await C[n].call('POST', `/api/teams/${teamId}/memos/summarize`, { noteIds: ids }), 'AI 정리');
        shared[n] = sum.data.text;
        ok(await C[n].call('POST', `/api/teams/${teamId}/shared`, { text: sum.data.text, sourceNoteIds: ids, visibility: 'ai_only' }), '공유');
      } else {
        shared[n] = sc.members[n].join('\n');
        for (const t of sc.members[n]) ok(await C[n].call('POST', `/api/teams/${teamId}/shared`, { text: t, visibility: 'ai_only' }), '공유');
      }
    }
    // 관찰자(메모 없음)는 두 질문 모두, 메모를 쓴 사람 둘은 첫 질문을 묻는다
    const asks = sc.chain ? [...sc.chain.map((q) => [OBSERVER, q]), [names[0], sc.questions[0]], [names[1], sc.questions[0]]]
      : [[OBSERVER, sc.questions[0]], [OBSERVER, sc.questions[1]], ...(sc.extra ?? []).map((q) => [OBSERVER, q]), [names[0], sc.questions[0]], [names[1], sc.questions[0]]];
    for (const [who, q] of asks) {
      const r = await C[who].call('POST', `/api/tasks/${taskId}/chat`, { question: q, clientRequestId: crypto.randomUUID() });
      rows.push({ scenario: sc.name, asker: who, question: q, status: r.data.status ?? `HTTP ${r.status}`, answer: r.data.answer ?? null,
        own: who === OBSERVER ? [] : sc.members[who], ownShared: shared[who] ?? null,
        others: names.filter((n) => n !== who).map((n) => ({ who: n, memos: sc.members[n] })), sources: (r.data.sources ?? []).length });
      console.log(`[${sc.name}] ${who} · ${q} · ${r.data.status}`);
    }
  } finally {
    for (const c of all) if (c.code) await c.call('DELETE', '/api/auth/me', { loginCode: c.code }).catch(() => null);
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  for (const i of WHICH.split(',').map(Number)) { out.push(...(await run(SCENARIOS[i]))); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
  console.log('rows', out.length);
}
