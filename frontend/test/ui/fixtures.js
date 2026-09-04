// UI 회귀 테스트가 화면에 흘려 넣는 답변과 trace. probe.jsx(그리는 쪽)와 ui.test.mjs(재는 쪽)가
// 같은 것을 봐야 하므로 JSX가 없는 이 파일에 둔다 — 재는 쪽이 픽스처를 눈대중으로 베껴 적으면,
// 픽스처를 고친 날 검사는 조용히 다른 것을 재게 된다.
import { MAX_PIE_SLICES, MAX_CHARTS_PER_MESSAGE, MAX_SERIES, MAX_NAME_LEN, MAX_LABEL_LEN, MAX_TITLE_LEN,
  CHART_FENCE_RE } from '../../src/chart.js';
import { stepLabel, searchLabel, traceSummary } from '../../src/trace.js';

// 원그래프 조각 수의 상한을 늘 넘겨 둔다 — '기타'로 모으는 길이 실제로 밟힌다. 정해진 목록을
// 잘라 쓰면 상한이 목록 길이에 닿는 순간 조용히 넘지 못하게 되고(그날 '기타'는 그려지지 않는데
// 검사는 그대로 통과한다), 그래서 모자라면 이름을 만들어 채운다.
const 이름들 = ['서울 리전 웹서버 그룹', '부산 리전 배치 노드', '대전 데이터센터 백업 스토리지', '인천 캐시 클러스터',
  '광주 로그 수집기', '대구 모니터링 노드', '울산 게이트웨이', '세종 API 서버', '제주 CDN 엣지', '원주 DB 복제본',
  '전주 메시지 큐', '청주 예비 노드'];
export const NODE_NAMES = Array.from({ length: MAX_PIE_SLICES + 2 }, (_, i) => 이름들[i] ?? `예비 노드 ${i + 1}`);
// 값도 이름 수에서 낸다. '120에서 8씩 내린다'처럼 박아 두면 상한을 올린 날 뒤쪽 값이 0을 지나
// 음수가 되고, recharts는 음수 조각의 path를 그리지 않는다 — 조각 수가 조용히 모자라 검사는
// 애먼 앱을 탓한다. 모두 양수이면서 내림차순이라 '기타'로 모이는 것은 늘 작은 값들이다.
export const NODE_VALUES = NODE_NAMES.map((_, i) => (NODE_NAMES.length - i) * 8);

// 조회 결과의 셀 하나가 이만큼 길 수 있다. 서버의 셀 상한(backend constants.js MAX_CELL_LEN 200자)보다
// 넉넉히 잡는다 — 그 상한이 늘어도 이 픽스처가 먼저 걸리게. 띄어쓰기가 없어야 한다: 줄바꿈으로 접히는
// 글자는 상자를 밀어내지 않으므로, 접히지 않는 한 덩어리라야 '화면 밖으로 나가는가'를 실제로 잰다.
export const LONG_CELL = '노드'.repeat(120);

// 상한에 꽉 찬 이름 하나. 길이를 상수에서 받아 오는 이유는 NODE_VALUES와 같다 — 상한을 바꾼 날
// 픽스처가 상한 아래로 내려가면, 그 검사는 아무것도 재지 않으면서 초록불을 낸다.
// 띄어쓰기는 두지 않는다: 접히는 글자는 상자를 밀어내지 않으므로 한 덩어리라야 실제로 잰다.
const 꽉찬이름 = (len, i) => '노드이름'.repeat(Math.ceil(len / 4)).slice(0, len - String(i).length) + i;
// 시리즈 이름이 상한까지 길고 시리즈도 상한까지 많은 답변. 그 범례를 그림 상자 '안'에 두면 범례가
// 그래프 몫의 높이를 통째로 가져가, 막대도 축도 눈금선도 없이 범례만 선 그림이 남는다(실측: 창
// 1000px에서 그려진 요소 0개). 이름은 조회 결과의 열 이름 그대로이므로 이 길이가 실제로 온다.
export const LONG_SERIES_NAMES = Array.from({ length: MAX_SERIES }, (_, i) => 꽉찬이름(MAX_NAME_LEN, i));
// 범주 이름이 축 눈금 상한까지 긴 눕힌 막대(범주 13개 이상, Chart.jsx HORIZONTAL_FROM). 그 축은
// 라벨만큼 넓어지므로(width="auto") 좁은 화면에서는 축 하나가 상자를 다 먹는다(실측: 창 320px에서
// 막대 0개, 창 380px에서 막대가 설 자리 23px).
export const LONG_CATEGORY_NAMES = Array.from({ length: 15 }, (_, i) => 꽉찬이름(MAX_LABEL_LEN, i));
// 상한을 훌쩍 넘긴 제목. 차트를 그릴 때는 MAX_TITLE_LEN으로 잘리는데, 그리지 못한 블록의 제목도
// 같은 길이여야 한다 — 한쪽만 묶여 있으면 그것은 상한이 아니다.
export const LONG_TITLE = '제목'.repeat(MAX_TITLE_LEN);

// 모델이 쓴 주소가 조회 결과를 실어 나르면 이만큼 길어진다 (화면에 그대로 펴지면 답이 묻힌다).
export const LONG_URL = `https://ex.test/report?q=${encodeURIComponent('가'.repeat(300))}`;
export const DATA_URL = 'data:image/png;base64,AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMM';
export const MAIL_URL = 'mailto:a@b.test';
// images 답변의 마지막 줄 — 이것이 그려졌으면 그 답변은 다 그려진 것이다 (아래 READY)
export const NESTED_LINK = 'https://ex.test/page';
// 페이지 안 앵커 — 그림 자리와 링크 자리가 같은 판정을 내는지 보는 주소.
// ASCII로 둔다: 마크다운은 한글 조각을 퍼센트 인코딩해 href에 넣으므로(#현황 → #%ED%98%84%ED%99%A9)
// 재는 쪽이 픽스처의 글자를 그대로 찾으면 있는 것도 없다고 나온다.
export const ANCHOR_URL = '#status-now';
export const ANCHOR_TEXT = '앵커 링크';
export const ANCHOR_IMG_TEXT = '앵커 그림';

// 원그래프 라벨의 자리를 재는 답변 둘의 이름. 긴 이름(축 눈금 상한 30자 안쪽의 스무 자 남짓)은
// 데스크톱 폭에서도 조각 곁에 들어가지 못해 범례로 내려가야 하고, 짧은 이름은 지금까지처럼 곁에
// 남아야 한다 — 한쪽만 재면 '늘 범례로 내린다'도 통과한다(Chart.jsx useLabelsFit).
export const PIE_LONG_NAMES = ['서울 리전 웹서버 그룹 프라이머리 노드 알파', '부산 리전 배치 처리 노드 세컨더리 베타',
  '대전 데이터센터 백업 스토리지 감마 델타', '인천 캐시 클러스터 엡실론'];
export const PIE_SHORT_NAMES = ['서울', '부산', '대전', '인천'];
const pieOf = names => ['```chart', 'type: pie', 'title: 노드별 처리 건수', '| 노드 | 건수 |', '| --- | --- |',
  ...names.map((n, i) => `| ${n} | ${40 - i * 5} |`), '```'].join('\n');

// 원그래프가 될 차트 블록의 원문(펜스 안쪽 — App.jsx가 ```chart 블록에서 꺼내 주는 그 글자).
// 따로 내주는 이유: 조각이 몇이어야 하는지를 재는 쪽이 '이름 수와 상한'으로 다시 셈하면 그것은 앱의
// 규칙을 검사가 한 벌 더 구현한 것이다. 이 원문을 진짜 파서에 그대로 넣어 물어보게 한다(ui.test.mjs).
export const PIE_BLOCK = ['type: pie', 'title: 노드별 처리 건수', '| 노드 | 건수 |', '| --- | --- |',
  ...NODE_NAMES.map((n, i) => `| ${n} | ${NODE_VALUES[i]} |`)].join('\n');

export const CASES = {
  // 글·표·차트 둘·흐름도·수식·목록이 모두 든 보통의 답변. 차트와 흐름도는 모듈을 내려받은 뒤에
  // 자리를 잡으므로, 이 답변 하나로 '뒤늦게 커지는' 상황이 실제로 만들어진다.
  rich: ['## 현황', '', `조회 결과 **${NODE_NAMES.length}개 노드**가 등록되어 있습니다.`,
    '평균은 $\\bar{x} = \\frac{1}{n}\\sum x_i$ 로 계산했습니다.', '',
    '| 지표 | 값 |', '| --- | --- |', `| 등록 노드 | ${NODE_NAMES.length} |`, '| 가동 중 | 11 |', '',
    '```chart', PIE_BLOCK, '```', '',
    '```chart', 'type: bar', 'title: 시간대별 요청 수', '| 시간 | 요청 | 오류 |', '| --- | --- | --- |',
    ...['00시', '04시', '08시', '12시', '16시', '20시'].map((h, i) => `| ${h} | ${300 + i * 140} | ${i * 7} |`), '```', '',
    '```mermaid', 'flowchart LR', '  A[사용자 질문] --> B{지식에 있는가}', '  B -->|있다| C[답변 생성]',
    '  B -->|없다| D[조회 계획]', '  D --> E[쿼리 실행]', '  E --> F[결과 요약]', '  F --> C', '```', '',
    ...Array.from({ length: 10 }, (_, i) => `${i + 1}. 점검 항목 ${i + 1} — 노드 상태·디스크·버전을 확인합니다.`)].join('\n'),
  // 모델이 쓴 주소가 저절로 불려 나가는지, 그리고 열어 주지 않는 주소를 화면이 어떻게 남기는지 보는 답변
  images: ['![상대](/__probe-pixel.png?a=1)', '', '![바깥](https://ex.test/b.png)', '',
    `![메일](${MAIL_URL})`, '', `![도표](${DATA_URL})`, '', `![](${LONG_URL})`, '',
    // 페이지 안 앵커는 그림이든 링크든 제자리에서 연다 — 한쪽만 새 탭이면 같은 자리를 가리키는
    // 주소가 대화 없는 앱을 한 벌 더 띄운다 (App.jsx NewTabLink·AltImage, markdown.js isInPage)
    `[${ANCHOR_TEXT}](${ANCHOR_URL})`, '', `![${ANCHOR_IMG_TEXT}](${ANCHOR_URL})`, '',
    `[![링크안](/__probe-pixel.png?c=3)](${NESTED_LINK})`].join('\n'),
  // 차트 블록의 표도 본문과 같은 그림 규칙인가. 이쪽 파이프라인(App.jsx ChartTable)은 그림 주소를
  // 원문 그대로 넘기므로 TABLE_MD의 img 하나가 유일한 관문이다 — 그 자리가 비면 조회 결과가
  // 섞인 셀의 ![](주소)가 사용자가 누르기도 전에 바깥으로 나가는 요청이 된다.
  tableimg: ['```chart', 'type: bar', 'title: 셀 안의 그림',
    '| 이름 | 값 |', '| --- | --- |',
    '| ![셀그림](/__probe-pixel.png?e=5) | 3 |', '| 평범한 이름 | 5 |', '```'].join('\n'),
  // 인쇄에서 잘리는지 보는 답변 — 화면에서 가로로 넘치는 넓은 표. 종이에는 가로 스크롤이 없어
  // 화면의 가둠(.md table의 overflow-x)이 그대로 '오른쪽을 버린다'가 된다(index.html @media print).
  // 열은 어느 창 폭에서도 넘치도록 넉넉히 둔다 — 넘치지 않으면 그 시험은 아무것도 재지 않는다.
  wideprint: [`| ${Array.from({ length: 14 }, (_, i) => `아주 긴 열 이름 ${i + 1}`).join(' | ')} |`,
    `|${' --- |'.repeat(14)}`,
    ...Array.from({ length: 3 }, (_, r) =>
      `| ${Array.from({ length: 14 }, (_, i) => `값 ${r + 1}-${i + 1} 조금 길게`).join(' | ')} |`)].join('\n'),
  // 흐름도 라벨에 HTML을 넣은 답변
  mermaidhtml: ['```mermaid', 'flowchart LR',
    '  A["<img src=/__probe-pixel.png?d=4>"] --> B["<b>굵게</b>"]', '```'].join('\n'),
  // 같은 라벨을, 설정을 덮어쓰는 문 둘(머리말의 config·`%%{init}%%` 지시문)로 HTML 라벨을 되살려 놓고
  // 넣은 답변. 머리말은 맨 앞이어야 하고 지시문은 그 뒤에 온다. 지키지 않으면 <img>가 서서 주소가
  // 불려 나가고, <a>는 같은 탭에서 열리는 링크가 된다(Mermaid.jsx secure).
  mermaiddirective: ['```mermaid', '---', 'config:', '  htmlLabels: true', '---',
    '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%', 'flowchart LR',
    '  A["<img src=/__probe-pixel.png?f=6>"] --> B["<a href=/__probe-link>링크</a>"]', '```'].join('\n'),
  // 흐름도 안의 링크(`click`). mermaid는 strict에서도 링크를 남기되 target은 주지 않고 `_self`는 두어
  // 같은 탭에서 열린다 — 답변의 링크와 같은 규칙(새 탭, 앵커만 제자리)이어야 한다(Mermaid.jsx).
  mermaidclick: ['```mermaid', 'flowchart LR', '  A[하나] --> B[둘] --> C[셋]',
    `  click A "${NESTED_LINK}" _self`, `  click B "${ANCHOR_URL}"`, '  click C "javascript:alert(1)"', '```'].join('\n'),
  // 흐름도의 그림 노드. mermaid는 이 노드의 크기를 재려고 그리는 도중에 주소를 불러온다 — 그림이 서기도
  // 전에 요청이 나간다(실측). 그리지 않고 원문 코드가 남아야 한다(markdown.js mermaidLoadsImage).
  mermaidimg: ['```mermaid', 'flowchart LR', '  A@{ img: "/__probe-pixel.png?i=7", label: "그림", pos: "b", w: 60, h: 60 } --> B[둘]', '```'].join('\n'),
  // 지시문의 themeCSS·fontFamily는 그 글자가 <style>에 그대로 들어가는 자리다 — 그 안의 url(…)은 mermaid가
  // 크기를 재려고 SVG를 문서에 넣는 순간 요청이 된다(실측). 그리지 않고 원문 코드가 남아야 한다
  // (markdown.js mermaidFetchesViaStyle).
  mermaidstyle: ['```mermaid',
    '%%{init: {"themeCSS": ".node rect { background: url(/__probe-pixel.png?t=8) }", "fontFamily": "x; background-image: url(/__probe-pixel.png?g=9)"}}%%',
    'flowchart LR', '  A[하나] --> B[둘]', '```'].join('\n'),
  pielong: pieOf(PIE_LONG_NAMES),
  pieshort: pieOf(PIE_SHORT_NAMES),
  // 조회 결과의 셀·열 이름이 그대로 차트의 이름이 되는 답변. 그 길이를 묶지 않으면 툴팁 상자가 그만큼
  // 옆으로 자라 화면 밖으로 나가고(실측 2,513px 상자, 1,000px 창의 오른쪽 1,653px 밖), 나간 글자는
  // 말풍선의 overflow-x: clip에 잘려 어디에서도 읽을 수 없다.
  longnames: ['```chart', 'type: bar', 'title: 긴 이름',
    `| 이름 | ${LONG_CELL} |`, '| --- | --- |', `| ${LONG_CELL} | 5 |`, '| 짧은것 | 9 |', '```'].join('\n'),
  // 그림 상자의 곁것(범례·범주 축)이 상자를 다 먹어 그림이 사라지던 두 자리. 한 답변에 함께 둔다 —
  // 둘은 같은 계약이다: recharts가 스스로 크기를 정하는 곁것은 그림 몫을 남겨 두어야 한다.
  longnamechart: ['```chart', 'type: bar', 'title: 긴 이름 여섯 열',
    `| 월 | ${LONG_SERIES_NAMES.join(' | ')} |`, `|${' --- |'.repeat(LONG_SERIES_NAMES.length + 1)}`,
    ...['1월', '2월', '3월'].map((m, r) => `| ${m} | ${LONG_SERIES_NAMES.map((_, i) => (r + 1) * (i + 1) * 10).join(' | ')} |`),
    '```', '',
    '```chart', 'type: bar', 'title: 눕힌 막대', '| 항목 | 값 |', '|---|---|',
    ...LONG_CATEGORY_NAMES.map((n, i) => `| ${n} | ${(i * 37) % 90 + 10} |`), '```'].join('\n'),
  // 그린 블록과 그리지 못한 블록이 같은 제목을 단다 — 제목의 길이는 두 갈래에서 같아야 한다.
  // 뒤 블록은 값 열이 글자라 그리지 못한다(chart.js '숫자 열 없음').
  longtitle: ['```chart', 'type: bar', `title: ${LONG_TITLE}`, '| 이름 | 값 |', '|---|---|', '| a | 1 |', '| b | 2 |', '```', '',
    '```chart', 'type: bar', `title: ${LONG_TITLE}`, '| 이름 | 값 |', '|---|---|', '| a | 글자 |', '| b | 글자 |', '```'].join('\n'),
  // 각주가 달린 답변. 각주 묶음의 제목·되돌아가기 글자는 remark-rehype가 붙이는데 기본값이 영어다.
  footnote: ['본문에 각주가 있습니다[^1].', '', '[^1]: 각주 내용입니다.'].join('\n'),
  // 눕힌 막대(범주 13개 이상, Chart.jsx HORIZONTAL_FROM)와 세로 막대 한 벌 — 툴팁이 마우스 자리의 행을 맞게
  // 찾는지 두 방향 모두에서 본다. 눕힌 쪽은 범주 축이 YAxis(yAxisId="left")라 툴팁이 축을 따로 받아야 한다.
  bars: ['```chart', 'type: bar', 'title: 눕힌 막대', '| 항목 | 값 |', '|---|---|',
    ...Array.from({ length: 15 }, (_, i) => `| 항목${i + 1} | ${(i * 37) % 90 + 10} |`), '```', '',
    '```chart', 'type: bar', 'title: 세로 막대', '| 항목 | 값 |', '|---|---|',
    ...Array.from({ length: 5 }, (_, i) => `| 열${i + 1} | ${(i * 37) % 90 + 10} |`), '```'].join('\n'),
};

// 서버가 줄 수 없어야 하지만 줄 수는 있는 응답들 — 배포가 어긋난 서버, 중간에 낀 프록시의 응답.
// 하나라도 그대로 화면에 닿아 렌더 도중에 던지면 React는 앱 전체를 내리고, 이 화면의 대화는
// 메모리에만 있으므로 통째로 사라진다. 앞의 것들은 '모양'으로 던지고(App.jsx가 문 앞에서 맞춘다),
// 마지막 하나는 모양이 아니라 '글자'로 던진다 — 겹친 인용은 markdown 파서의 스택을 넘긴다
// (실측: 3천 겹부터 RangeError로 화면이 백지가 됐다. 서버 상한 70,000자 안에 드는 글자다).
// 그것은 문 앞 정리로는 막을 수 없고 말풍선 경계(App.jsx Boundary)만이 잡는다 — 둘 다 있어야
// '어떤 응답에도 앱이 내려가지 않는다'가 성립하므로 한 목록에 함께 둔다.
export const BROKEN_RESPONSES = [
  { answer: 12345 },                                     // 문자열이 아닌 답 (react-markdown이 던진다)
  { answer: { text: '객체' } },
  { answer: '답은 정상입니다.', trace: 'trace가 배열이 아니다' },   // trace.map이 없다
  { answer: '답은 정상입니다.', trace: [null] },                  // 스텝이 없다
  { answer: '답은 정상입니다.', trace: [{ query_name: { a: 1 }, params: { x: 1 }, rows: '행이 배열이 아니다' }] },
  null,                                                  // 본문이 통째로 없다
  { answer: `${'>'.repeat(20000)} 겹친 인용` },            // 글자만으로 렌더가 던진다
];

const COLS = ['node_id', 'node_name', 'region', 'status', 'cpu_pct', 'agent_version'];
const ROWS = Array.from({ length: 30 }, (_, i) => Object.fromEntries(COLS.map(c => [c, `${c}-값-${i + 1}-조금-길게-써서-가로로-넘치게-한다`])));

// 서버(backend/src/result.js clientTrace)가 실제로 주는 네 모양을 모두 담는다. 상한에 걸린 결과와
// 오류 스텝을 빼 두면, 그 문구를 만드는 자리(trace.js countLabel·App.jsx TraceStep)가 화면에서는
// 한 번도 그려지지 않아 'undefined건'이 나가도 검사가 모두 통과한다.
export const TRACE = [
  { query_name: 'vm_agent_dashboard_list', targetDb: 'space_ops', params: { limit: 30 }, rowCount: 30, rows: ROWS },
  { query_name: 'vm_agent_health_summary', targetDb: 'space_ops', params: {}, rowCount: 3, rows: ROWS.slice(0, 3) },
  // 상한에 걸렸고 실린 것은 그중 일부다 (rowCount의 '+'는 서버가 붙인다)
  { query_name: 'vm_agent_event_scan', targetDb: 'space_ops', params: { days: 30 }, rowCount: '1000+', capped: true, omittedRows: 970, rows: ROWS },
  // 실행되지 못한 스텝 — rows 자체가 없다(빈 배열이 아니다: '0건 조회 성공'으로 읽히지 않게)
  { query_name: 'vm_agent_missing', targetDb: 'space_ops', params: {}, rowCount: 0, error: '조회 중 오류가 발생했습니다.' },
];

// 위 두 스텝이 화면에 남겨야 하는 문구. 만드는 자리(trace.js stepLabel — 화면도 그것을 부른다)에서
// 그대로 받아 온다: 눈대중으로 베껴 적으면 문구를 다듬은 날 검사가 조용히 옛 계약을 재게 된다.
export const CAPPED_LABEL = stepLabel(TRACE.find(t => t.capped));
export const ERROR_LABEL = stepLabel(TRACE.find(t => t.error));

// 답변이 '다 그려졌다'를 무엇으로 아는가. 세는 쪽이 눈대중으로 베껴 적으면 픽스처를 늘린 날
// 검사는 반쯤 그려진 화면을 재게 되므로, 답변을 가진 이 파일이 직접 낸다.
// 그리는 차트 수는 블록 수가 아니라 한 답변의 예산까지 본다(App.jsx ChartBlock) — 예산을 넘겨
// 픽스처를 늘린 날, 오지 않을 다섯 번째 차트를 기다리다 검사가 통째로 시간 초과로 죽지 않게.
// 차트 블록은 앱이 쓰는 그 정규식으로 센다(CHART_FENCE_RE) — 여기서 '```chart' 한 줄로 다시 적으면
// 앱이 차트로 받는 것(들여쓴 펜스, ```chart 뒤의 덧말)을 검사만 못 알아본다. 그러면 마지막 차트가
// 아직 서는 중에 '다 그려졌다'가 되어, 뒤의 검사들이 자라는 화면을 6px로 재며 애먼 자리를 탓한다.
const 그릴차트수 = Math.min((CASES.rich.match(CHART_FENCE_RE) ?? []).length, MAX_CHARTS_PER_MESSAGE);
// 주소로 찾는 선택자. 따옴표를 직접 붙이면 주소에 따옴표가 하나만 섞여도 페이지 안에서 문법 오류가
// 되어, 기다리는 대신 낯선 SyntaxError로 죽는다 (driver.mjs goto·ui.test.mjs seen과 같은 규칙).
export const 주소를_가리키는_링크 = url => JSON.stringify(`.md a[href=${JSON.stringify(url)}]`);

export const READY = {
  // 차트 하나에 .recharts-surface가 하나뿐이라고 보면 안 된다 — 범례의 아이콘도 같은 클래스다.
  rich: `[...document.querySelectorAll('figure.chart')].filter(f => f.querySelector('.recharts-surface')).length === ${그릴차트수}
         && document.querySelector('.mermaid svg')`,
  images: `document.querySelector(${주소를_가리키는_링크(NESTED_LINK)})`,
  mermaidhtml: `document.querySelector('.mermaid svg')`,
  mermaiddirective: `document.querySelector('.mermaid svg')`,
  mermaidclick: `document.querySelector('.mermaid svg')`,
  // 그리지 않는 것이 맞는 답이다 — 원문 코드가 선 것으로 '다 그려졌다'를 안다
  mermaidimg: `document.querySelector('.bubble.assistant pre code')`,
  mermaidstyle: `document.querySelector('.bubble.assistant pre code')`,
  wideprint: `document.querySelector('.md table')`,
  pielong: `document.querySelector('figure.chart .recharts-pie-sector')`,
  pieshort: `document.querySelector('figure.chart .recharts-pie-sector')`,
  longnames: `document.querySelector('figure.chart .recharts-bar-rectangle .recharts-rectangle')`,
  // 두 차트가 모두 '무언가를 그렸다'까지 기다린다 — 막대로 기다리면 고치기 전에는 영영 서지 않아
  // 시험이 실패가 아니라 시간 초과로 죽는다(그러면 무엇이 잘못됐는지는 말해 주지 않는다).
  longnamechart: `document.querySelectorAll('figure.chart').length === 2
    && [...document.querySelectorAll('figure.chart')].every(f => f.querySelector('.recharts-wrapper svg'))`,
  longtitle: `document.querySelector('figure.chart .recharts-surface') && document.querySelector('.md strong')`,
  footnote: `document.querySelector('.md .footnotes')`,
  bars: `document.querySelectorAll('figure.chart').length === 2 && [...document.querySelectorAll('figure.chart')].every(f => f.querySelector('.recharts-bar-rectangle .recharts-rectangle'))`,
  // 차트가 서고 '표로 보기'의 표까지 붙은 뒤라야 셀 안의 그림을 볼 수 있다(접혀 있어도 DOM에는
  // 있고, 브라우저는 접힌 <details> 안의 <img>도 불러온다).
  tableimg: `document.querySelector('figure.chart .recharts-surface') && document.querySelector('.md .chart-table table')`,
};

// ===== 진행 상황 스트림 =====
// probe.jsx가 ?stream=1이면 이 이벤트들을 한 줄씩 흘려보낸 뒤 done을 준다 (backend agent.js가 내는 모양).
// 검색 하나와 조회 하나 — 시작 이벤트가 줄을 세우고 끝 이벤트가 결과를 붙이는 두 길을 다 밟는다.
export const STREAM_SEARCH = { text: '가상계측 배치 재시작', targets: ['knowledge', 'qa_method'] };
const STREAM_HITS = { knowledge: 2, qaMethods: 1, queries: null };
export const STREAM_EVENTS = [
  { type: 'search', ...STREAM_SEARCH },
  { type: 'search_done', ...STREAM_SEARCH, hits: STREAM_HITS },
  // id는 실제 서버가 시작·끝 이벤트에 늘 싣는 짝 번호다 (backend agent.js runBatch) — 픽스처에서 빼면
  // 화면 검사가 이름으로 물러서는 길만 밟고, 정작 운영에서 쓰이는 길은 한 번도 지나지 않는다.
  { type: 'run_query', id: 1, query_name: 'vm_agent_health_summary', targetDb: 'space_ops', params: {} },
  { type: 'run_query_done', id: 1, query_name: 'vm_agent_health_summary', targetDb: 'space_ops', rowCount: 3 },
];
// done 줄의 trace — 검색 항목이 쿼리 항목 앞에 선다 (서버 result.js clientTrace가 주는 순서)
export const STREAM_TRACE = [{ search: STREAM_SEARCH.text, targets: STREAM_SEARCH.targets, hits: STREAM_HITS }, ...TRACE];
// 화면에 남아야 하는 문구. 만드는 자리(trace.js)에서 그대로 받아 온다 — CAPPED_LABEL과 같은 이유.
export const STREAM_SEARCH_LABEL = searchLabel(STREAM_TRACE[0]);
export const STREAM_SUMMARY = traceSummary(STREAM_TRACE);

// 답변 미리보기 — 스트림 모드는 done 전에 답변을 이만큼씩 나눠 answer_delta로 흘린다 (probe.jsx).
// 첫 조각에 반드시 들어 있는 글자(첫 제목)로 '답이 오기 전에 미리보기가 섰다'를 잰다.
export const STREAM_ANSWER_CHUNKS = 3;
export const STREAM_PREVIEW_TEXT = CASES.rich.split('\n')[0].replace(/^#+\s*/, '');
