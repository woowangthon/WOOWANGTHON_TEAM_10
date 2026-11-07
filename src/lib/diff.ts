// 줄 단위 비교 (브라우저·서버 공용 순수 함수). 회의록 수정 기록에서 "어떤 부분을 고쳤는지" 보여줄 때 쓴다.
// 최장 공통 부분열(LCS)로 같은 줄을 맞추고, 나머지를 지운 줄 / 더한 줄로 표시한다.

export type DiffLine = { op: "same" | "add" | "del"; text: string };

const MAX_CELLS = 4_000_000; // 2000줄 × 2000줄. 넘으면 통째로 바뀐 것으로 본다

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  }
  // lcs[i][j] = a[i..], b[j..] 의 공통 부분열 길이
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "del", text: a[i++]! });
    } else {
      out.push({ op: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++]! });
  while (j < b.length) out.push({ op: "add", text: b[j++]! });
  return out;
}

/** 바뀐 줄 주변만 남기고 같은 줄이 길게 이어지는 부분은 접는다 */
export function compactDiff(lines: DiffLine[], context = 1): (DiffLine | { op: "skip"; count: number })[] {
  const keep = lines.map((l, i) => l.op !== "same" || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== "same"));
  const out: (DiffLine | { op: "skip"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "skip", count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: "skip", count: skipped });
  return out;
}
