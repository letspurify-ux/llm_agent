import { resolveChartData } from '../../backend/src/chart.js';

export const NESTED_LITERAL_MATH = '\\text{`mermaid<br>literal`}';
export const NESTED_BOUNDARY_ANSWER = resolveChartData([
  '1. 복합 결과', '',
  '   > | 항목 | 내용 | 확인 |',
  '   > |---|---|---|',
  '   > | 흐름 | **설명 `mermaid\\nflowchart LR\\n A["label ``code`` | tail"] --> B["$$\\frac{1}{2}$$"]` 뒤** | DIAGRAM_END |',
  '   > | 조회 | `chart\\ntype: bar\\ntitle: 값 ``인용``\\ndata: step 1` | CHART_END |',
  '   > | 예시 | ``예시 `mermaid\\nflowchart LR\\nA-->B` 끝`` | CODE_END |',
  '   > | 수식 | $' + NESTED_LITERAL_MATH + '$ | MATH_END |',
  '   > | 주소 | [LINK](https://example.test/`mermaid<br>flowchart-LR`) | LINK_END |',
  '', '검증 끝 $z=9$',
].join('\n'), [[{ A: 'FOUND_ROW', B: 7 }]]);
