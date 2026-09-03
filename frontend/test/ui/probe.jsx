// UI 회귀 테스트가 띄우는 화면. 진짜 App을 진짜 진입점(main.jsx)으로 그대로 띄우고 /api/chat만
// 가로챈다 — 서버도 모델도 없이 '답이 도착하고, 차트·흐름도가 뒤늦게 자리를 잡는' 그 순간을
// 되풀이해서 만들 수 있어야 하기 때문이다.
// 화면 껍데기(CSS)는 index.html에서 그대로 가져온다 (ui.test.mjs가 그 파일로 probe용 html을 만든다).
import { CASES, TRACE } from './fixtures.js';

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

// 앱이 늦게 서는 화면. 옮겨 가는 기다림(driver.mjs goto)이 '새 문서가 생겼다'가 아니라 '앱이 실제로
// 섰다'까지 기다리는지 재려면, 그 사이가 눈에 보일 만큼 길어야 한다(ui.test.mjs가 ?slow=로 쓴다).
const slow = Number(new URLSearchParams(location.search).get('slow') ?? 0);
if (slow > 0) await new Promise(r => setTimeout(r, slow));

// 부팅은 흉내 내지 않고 진짜 것을 부른다(가로채기를 먼저 걸어 두려고 import를 여기서 한다).
// 여기서 createRoot를 한 벌 더 쓰면 main.jsx에 무엇이 더해져도 — 폴리필, 전역 오류 보고,
// StrictMode(렌더 횟수가 달라져 ChartBudget 같은 것이 영향을 받는다) — 검사는 아무도 쓰지 않는
// 부팅을 상대로 계속 초록불을 낸다.
await import('../../src/main.jsx');
