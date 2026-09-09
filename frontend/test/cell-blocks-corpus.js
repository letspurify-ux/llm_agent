import { resolveChartData } from '../../backend/src/chart.js';

export const CELL_CONTAINERS = [
  body => `- 부모\n  - 자식\n    ${body}\n- 다음`,
  body => `> 인용\n> - 부모\n>\n>   3. 자식\n>      ${body}\n>   4. 다음`,
  body => `1. 부모\n   > 인용\n   > - ${body}\n2. 다음`,
  body => `- [x] 완료\n  - [ ] ${body}\n- 다음`,
  body => `> > - ${body}\n> >   이어지는 설명\n> 끝`,
];
export const CELL_CHART = '`chart\\ntype:bar\\ndata:step1`';
export const CELL_MERMAID = '`mermaid\\nflowchart LR\\nA["$$x^2$$"] -->|label| B`';
export const CELL_BLOCKS_ANSWER = resolveChartData([
  '| 항목 | 내용 | 끝 |', '|---|---|---|',
  '| 수식 | ' + CELL_CONTAINERS[0]('**수식** $z=9$').replaceAll('\n', '<br>') + ' | CELL_MATH_END |',
  '| 그림 | ' + CELL_CONTAINERS[1](CELL_MERMAID).replaceAll('\n', '<br>') + ' | CELL_DIAGRAM_END |',
  '| 조회 | ' + CELL_CONTAINERS[2](CELL_CHART).replaceAll('\n', '<br>') + ' | CELL_CHART_END |',
  '| 작업 | ' + CELL_CONTAINERS[3]('[링크](https://example.test) `원문`').replaceAll('\n', '<br>') + ' | CELL_TASK_END |',
].join('\n'), [[{ A: 'FOUND_ROW', B: 7 }]]);

export const CELL_LITERAL_ANSWER = resolveChartData([
  '| 항목 | 내용 | 끝 |', '|---|---|---|',
  '| ESCAPE | 앞<br>\\- 목록 문자 $z=9$<br>1\\. 번호 문자<br>\\# 제목 문자 | ESCAPE_END |',
  '| ENTITY | 앞&lt;br&gt;&gt; 인용 문자<br>&num; 제목 문자<br>&#45; 목록 문자 | ENTITY_END |',
  '| TASK | 앞<br>- &#91;x&#93; 작업 문자<br>- [x] 실제 작업 | TASK_END |',
  '| GRAPH | 앞<br>\\- 그림 문자 ' + CELL_MERMAID + ' | GRAPH_END |',
  '| QUERY | 앞<br>&gt; 조회 문자 ' + CELL_CHART + ' | QUERY_END |',
].join('\n'), [[{ A: 'FOUND_ROW', B: 7 }]]);
