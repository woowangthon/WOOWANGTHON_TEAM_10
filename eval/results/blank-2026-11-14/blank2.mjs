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
export const SCENARIOS = [
  { name: '공모전', project: { title: '교내 공모전', purpose: '교내 아이디어 공모전 주제 정하고 준비하기' }, via: 'direct',
    members: { 가람: ['상금보다 완성도가 중요하다고 생각해. 무리해서 큰 주제 잡는 건 반대야'], 노을: ['솔직히 이번 공모전은 스펙 한 줄이 목적이라 수상 못 해도 상관없어'], 단비: ['매주 금요일 저녁은 교회 모임이 있어서 회의 못 해'] },
    questions: ['공모전 주제 추천해줘', '회의 일정은 어떻게 잡을까?'], extra: ['회의록 양식 만들어줘'] },
  { name: '회비', project: { title: '동아리 회비', purpose: '다음 학기 동아리 회비 운영 방식 정하기' }, via: 'summarize',
    members: { 도담: ['회비 올리는 건 반대야. 지금도 내기 버거운 사람이 있을 거야'], 라미: ['총무 맡은 세진이가 정산을 자꾸 미뤄서 불만이야'], 모아: ['나는 뒤풀이 비용을 회비에서 쓰는 게 싫어'] },
    questions: ['회비 운영 방식 제안해줘', '총회 안건 정리해줘'] },
  { name: '제주', project: { title: '제주도 여행', purpose: '친구 넷이 가는 제주도 2박 3일 여행 계획' }, via: 'direct',
    members: { 별: ['수영을 못해서 물놀이 일정은 빼고 싶어'], 산: ['운전은 나만 할 수 있는데 장거리 운전은 솔직히 부담돼'], 은: ['숙소는 무조건 1인 1침대였으면 좋겠어. 같이 자는 거 불편해'] },
    questions: ['제주도 2박 3일 일정 짜줘', '숙소는 어떻게 고르면 좋을까?'] },
  { name: '실험', project: { title: '일반화학 실험', purpose: '일반화학 실험 조 역할 나누고 보고서 쓰기' }, via: 'summarize',
    members: { 진: ['보고서는 내가 쓰고 싶어. 실험 조작은 손이 떨려서 자신 없어'], 찬: ['지난 실험 데이터가 좀 이상했는데 조작한 사람이 실수한 것 같아'], 한: ['수요일은 다른 수업 과제 마감이라 그날 모이면 힘들어'] },
    questions: ['실험 역할 어떻게 나눌까?', '보고서 목차 추천해줘'] },
  { name: '교양발표', project: { title: '교양 수업 팀 발표', purpose: '교양 수업 팀 발표 주제 정하고 준비하기' }, via: 'direct',
    members: { 가을: ['환경 주제는 너무 뻔해서 싫어'], 겨울: ['나는 통계 자료 찾는 걸 좋아하니 데이터 많은 주제면 좋겠어'], 봄: ['발표 시간이 길어지는 게 싫어. 10분 넘기지 말자'] },
    questions: ['발표 주제 추천해줘', '발표 구성은 어떻게 할까?'],
    // 관찰자가 한 대화에서 아홉 번 묻는다 (최근 대화 6턴을 넘겨 대화 요약이 만들어지게)
    chain: ['발표 주제 추천해줘', '그중에 하나만 골라줘', '왜 그걸 골랐어?', '발표 시간은 몇 분이 좋을까?', '자료는 어디서 찾을까?', '역할은 어떻게 나눌까?', '슬라이드는 몇 장이 좋을까?', '첫 장에는 뭘 넣을까?', '지금까지 정한 걸 정리해줘. 그리고 다른 팀원들이 원하는 게 있으면 알려줘'] },
  { name: '축제', project: { title: '학과 축제 부스', purpose: '학과 축제 부스 아이템 정하고 역할 나누기' }, via: 'summarize',
    members: { 다온: ['부스에서 음식 파는 건 위생 문제로 걱정돼'], 라희: ['나는 사람 많은 데서 호객하는 역할은 못 하겠어'], 마음: ['예산 초과되면 내 사비로 메꾸게 될까 봐 걱정이야'] },
    questions: ['축제 부스 아이템 추천해줘', '역할 분담안 만들어줘'] },
];
const OBSERVER = '관찰자';

async function run(sc) {
  const names = Object.keys(sc.members); const C = {}; const all = [];
  for (const n of [...names, OBSERVER]) { C[n] = new Client(); all.push(C[n]); }
  const rows = [];
  try {
    const s = ok(await C[names[0]].start({ displayName: names[0], teamName: `백지2 ${sc.name} ${Date.now().toString(36)}` }), '가입');
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
