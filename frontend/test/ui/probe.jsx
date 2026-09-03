// UI 회귀 테스트가 띄우는 화면. 진짜 App을 그대로 쓰고 /api/chat만 가로챈다 — 서버도 모델도 없이
// '답이 도착하고, 차트·흐름도가 뒤늦게 자리를 잡는' 그 순간을 되풀이해서 만들 수 있어야 하기 때문이다.
// 화면 껍데기(CSS)는 index.html에서 그대로 가져온다 (ui.test.mjs가 그 파일로 probe용 html을 만든다).
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import 'katex/dist/katex.min.css';

const names = ['서울 리전 웹서버 그룹', '부산 리전 배치 노드', '대전 데이터센터 백업 스토리지', '인천 캐시 클러스터',
  '광주 로그 수집기', '대구 모니터링 노드', '울산 게이트웨이', '세종 API 서버', '제주 CDN 엣지', '원주 DB 복제본',
  '전주 메시지 큐', '청주 예비 노드'];

const CASES = {
  // 글·표·차트 둘·흐름도·수식·목록이 모두 든 보통의 답변. 차트와 흐름도는 모듈을 내려받은 뒤에
  // 자리를 잡으므로, 이 답변 하나로 '뒤늦게 커지는' 상황이 실제로 만들어진다.
  rich: ['## 현황', '', '조회 결과 **12개 노드**가 등록되어 있습니다.',
    '평균은 $\\bar{x} = \\frac{1}{n}\\sum x_i$ 로 계산했습니다.', '',
    '| 지표 | 값 |', '| --- | --- |', '| 등록 노드 | 12 |', '| 가동 중 | 11 |', '',
    '```chart', 'type: pie', 'title: 노드별 처리 건수', '| 노드 | 건수 |', '| --- | --- |',
    ...names.map((n, i) => `| ${n} | ${120 - i * 8} |`), '```', '',
    '```chart', 'type: bar', 'title: 시간대별 요청 수', '| 시간 | 요청 | 오류 |', '| --- | --- | --- |',
    ...['00시', '04시', '08시', '12시', '16시', '20시'].map((h, i) => `| ${h} | ${300 + i * 140} | ${i * 7} |`), '```', '',
    '```mermaid', 'flowchart LR', '  A[사용자 질문] --> B{지식에 있는가}', '  B -->|있다| C[답변 생성]',
    '  B -->|없다| D[조회 계획]', '  D --> E[쿼리 실행]', '  E --> F[결과 요약]', '  F --> C', '```', '',
    ...Array.from({ length: 10 }, (_, i) => `${i + 1}. 점검 항목 ${i + 1} — 노드 상태·디스크·버전을 확인합니다.`)].join('\n'),
  // 모델이 쓴 주소가 저절로 불려 나가는지 보는 답변
  images: ['![상대](/__probe-pixel.png?a=1)', '', '![바깥](https://ex.test/b.png)', '',
    '![메일](mailto:a@b.test)', '', '[![링크안](/__probe-pixel.png?c=3)](https://ex.test/page)'].join('\n'),
  // 흐름도 라벨에 HTML을 넣은 답변
  mermaidhtml: ['```mermaid', 'flowchart LR',
    '  A["<img src=/__probe-pixel.png?d=4>"] --> B["<b>굵게</b>"]', '```'].join('\n'),
};

const COLS = ['node_id', 'node_name', 'region', 'status', 'cpu_pct', 'agent_version'];
const ROWS = Array.from({ length: 30 }, (_, i) => Object.fromEntries(COLS.map(c => [c, `${c}-값-${i + 1}-조금-길게-써서-가로로-넘치게-한다`])));
const TRACE = [
  { query_name: 'vm_agent_dashboard_list', targetDb: 'space_ops', params: { limit: 30 }, rowCount: 30, rows: ROWS },
  { query_name: 'vm_agent_health_summary', targetDb: 'space_ops', params: {}, rowCount: 3, rows: ROWS.slice(0, 3) },
];

const which = new URLSearchParams(location.search).get('case') ?? 'rich';
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  if (String(url).includes('/api/chat')) {
    await new Promise(r => setTimeout(r, 150)); // 서버가 답하기까지의 짧은 사이
    return new Response(JSON.stringify({ answer: CASES[which] ?? CASES.rich, trace: which === 'rich' ? TRACE : undefined }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

createRoot(document.getElementById('root')).render(<App />);
