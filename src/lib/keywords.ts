// 키워드 기준선 검색용 토큰 분리 (외부 라이브러리 없이, 브라우저·서버 공용 순수 함수).
// 한국어 조사를 아주 단순하게 떼어 낸다: "실험은" → "실험", "조건이" → "조건"
const PARTICLES = ["으로", "에서", "에게", "까지", "부터", "처럼", "보다", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만"];

export function keywordTokens(query: string, max = 40): string[] {
  const out = new Set<string>();
  for (let w of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2) continue;
    for (const p of PARTICLES) {
      if (w.length - p.length >= 2 && w.endsWith(p)) {
        w = w.slice(0, -p.length);
        break;
      }
    }
    out.add(w);
    if (out.size >= max) break;
  }
  return [...out];
}
