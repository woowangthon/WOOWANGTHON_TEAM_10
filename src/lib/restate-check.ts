// AI 정리문을 원문과 비교해 작성자에게 보여줄 경고를 만든다 (브라우저·서버 공용 순수 함수).
// 경고는 참고용이다. 최종 판단은 작성자가 원문과 정리문을 비교해 직접 한다.
export function restatementWarnings(
  raw: string,
  r: { summary: string; conditions: string[]; uncertainties: string[] },
): string[] {
  const nums = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const rawNums = nums(raw);
  const added = [...nums([r.summary, ...r.conditions, ...r.uncertainties].join(" "))].filter((n) => !rawNums.has(n));
  const warnings: string[] = [];
  if (added.length) warnings.push(`원문에 없는 숫자가 들어갔습니다: ${added.join(", ")}`);
  if (r.summary.length > Math.max(raw.length * 2, 80)) warnings.push("정리문이 원문보다 훨씬 깁니다. 없는 내용이 추가됐는지 확인하세요.");
  return warnings;
}
