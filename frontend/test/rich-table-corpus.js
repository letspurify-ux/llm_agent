export const USER_BREAK_TABLE = String.raw`| **항목설명** |                                                                        |
| -------- | ---------------------------------------------------------------------- |
| 성장률      | 성장률=이번 달 매출−지난달 매출지난달 매출×100\<br>\<br>- 매출 비교\<br>- 증감률 계산\<br>- 결과 표시 |
| 처리 상태    | **완료**\<br>\<br>1. 데이터 수집\<br>2. 수식 계산\<br>3. 결과 저장 |`;

export const INLINE_MERMAID = 'mermaid\\nflowchart TD\\n A[요청 접수] --> B[데이터 확인]\\n B --> C[결과 반환]\\n';
export const INLINE_CHART = 'chart\\ntype: bar\\ntitle: 월별 처리 건수\\nx: 월\\ny: 건수\\n| 월 | 건수 |\\n| --- | --- |\\n| 1월 | 12 |\\n| 2월 | 18 |\\n';
export const QUADRATIC = String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`;
export const SERIALIZED_QUADRATIC = String.raw`이차방정식 $ax^2+bx+c=0$의 근의 공식입니다.\n\n$$\nx=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\n$$\n\n단, $a\ne0$입니다.`;
const escapedFence = '\\`\\`\\`';
export const MEAN = String.raw`\bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i`;
export const MULTI_ELEMENT_TABLE = '| 항목 | 상세 내용 |\n|---|---|\n' +
  '| 평균 | $' + MEAN + '$<br><br>**계산 절차**<br>1. 관측값 합산<br>2. 관측 개수로 나눔<br><br>\\> 결측값은 사전에 처리해야 합니다. |\n' +
  '| 처리 흐름 | 입력 $x$ → 함수 적용 $f(x)$ → 결과 $y$<br>`mermaid<br>flowchart LR<br>A[입력] --> B[함수 적용]<br>B --> C[결과]<br>` |\n' +
  '| 추이 차트 | 예시 데이터<br>`' + INLINE_CHART.replaceAll('\\n', '<br>') + '` |';
export const STANDALONE_MERMAID = '`mermaid<br>flowchart LR<br>A[입력] --> B[함수 적용]<br>B --> C[결과]<br>`';
export const RICH_TABLE_ANSWER = [
  USER_BREAK_TABLE,
  '| 구분 | 중첩된 시각화 예시 | 비고 |\n|---|---|---|\n' +
  '| 처리 흐름 | `' + INLINE_MERMAID + '` | 흐름 이웃 |\n' +
  '| 월별 건수 | ' + escapedFence + INLINE_CHART + escapedFence + ' | 차트 이웃 |\n' +
  '| 미완성 차트 | ' + escapedFence + 'chart\\ntype: bar\\ntitle: 자료 없는 차트\\nx: 월\\ny: 건수\\n | 오류 이웃 |\n' +
  '| 수식 흐름 | `mermaid\\nflowchart LR\\n A["$$\\frac{1}{2}$$"] --> B[완료]\\n` | 수식 이웃 |',
  SERIALIZED_QUADRATIC,
  MULTI_ELEMENT_TABLE,
  String.raw`\> 표 밖의 주의사항도 인용문으로 표시합니다.`,
  STANDALONE_MERMAID,
  '코드 예시 `<br>`와 `\\n`은 유지합니다.',
  '```text\nmermaid\\nflowchart TD\\n A --> B\n<br>\n```',
  '검증 끝',
].join('\n\n');
