// 신고된 잘림 위치는 모두 절댓값 파이프 앞이다. 표 전체의 열·이웃 셀까지 검증한다.
export const TABLE_FORMULAS = [
  String.raw`\sqrt{a^2} = |a|`,
  String.raw`\int \frac{1}{x}\,dx = \ln |x| + C`,
  String.raw`\kappa = \frac{|x'y''-y'x''|}{(x'^2+y'^2)^{3/2}}`,
];

export const INCOMPLETE_TABLE_FORMULAS = [
  '$₩sqrt{a^2} =',
  '$&int ₩frac{1}{x},dx = ₩ln',
  '$₩kappa = ₩frac{',
  String.raw`$\frac{|x|}{`,
  String.raw`$\frac{|x|}{ $`,
];

export const TABLE_MATH_ANSWER = [
  '### 표 안 수식',
  '| 항목 | 계산식 | 설명 |\n|---|---|---|\n' + TABLE_FORMULAS.map((tex, i) =>
    `| 예시 ${i + 1} | $ ${tex.replaceAll('\\', '₩')} $ | 보존 ${i + 1} |`).join('\n'),
  '| 상태 | 수식 | 설명 |\n|---|---|---|\n' + INCOMPLETE_TABLE_FORMULAS.map((tex, i) =>
    `| 미완성 ${i + 1} | ${tex} | 원문 ${i + 1} |`).join('\n') + '\n| 정상 | $x=1$ | 다음 행 |',
  '금액 $100 · 원문 `$₩sqrt{a^2} =`',
].join('\n\n');
