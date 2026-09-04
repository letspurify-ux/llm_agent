// UI 회귀 테스트가 띄우는 화면. 진짜 App을 진짜 진입점(main.jsx)으로 그대로 띄우고 /api/chat만
// 가로챈다 — 서버도 모델도 없이 '답이 도착하고, 차트·흐름도가 뒤늦게 자리를 잡는' 그 순간을
// 되풀이해서 만들 수 있어야 하기 때문이다.
// 화면 껍데기(CSS)는 index.html에서 그대로 가져온다 (ui.test.mjs가 그 파일로 probe용 html을 만든다).
import { CASES, TRACE, BROKEN_RESPONSES, STREAM_EVENTS, STREAM_TRACE, STREAM_ANSWER_CHUNKS } from './fixtures.js';

const which = new URLSearchParams(location.search).get('case') ?? 'rich';
// ?broken=1 이면 정상 답 대신 BROKEN_RESPONSES를 한 번에 하나씩 차례로 내준다 — 한 대화 안에서
// 모든 모양을 겪게 해야 '그중 하나에서 앱이 내려가면 그 뒤 질문도 못 한다'까지 함께 재게 된다.
const broken = new URLSearchParams(location.search).has('broken');
// ?stream=1 이면 서버가 진행 상황을 흘려보내는 모양(NDJSON — backend server.js openStream)으로 답한다:
// STREAM_EVENTS를 ?gap= 간격으로 한 줄씩, 마지막에 done. 답이 오기 전에 검색 줄이 서는지를 재려면
// 이벤트 사이가 눈에 보일 만큼 벌어져야 한다.
const stream = new URLSearchParams(location.search).has('stream');
let 몇번째 = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  if (String(url).includes('/api/chat')) {
    // 서버가 답하기까지의 사이. 기본은 짧게 두고(대부분의 검사는 기다릴 이유가 없다), 답이
    // 오기 전에 화면을 만져 봐야 하는 검사만 ?delay=로 늘린다.
    // 끊으라는 신호(App.jsx의 AbortController — 홈 단추와 요청 상한이 쓴다)는 진짜 fetch와 같이
    // AbortError로 답한다. 그러지 않으면 여기서는 아무리 끊어도 답이 그대로 도착해, 끊는 길을
    // 지나는 검사가 사실은 아무것도 끊지 않은 채 초록불을 낸다.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Number(new URLSearchParams(location.search).get('delay') ?? 150));
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      });
    });
    if (stream) {
      const gap = Number(new URLSearchParams(location.search).get('gap') ?? 400);
      const enc = new TextEncoder();
      const line = obj => enc.encode(`${JSON.stringify(obj)}\n`);
      const body = new ReadableStream({
        async start(c) {
          for (const e of STREAM_EVENTS) {
            c.enqueue(line(e));
            await new Promise(r => setTimeout(r, gap));
          }
          // 답변 조각 — 서버가 답변 문자열을 디코딩해 흘리는 모양 (backend agent.js answer_delta)
          const answer = CASES[which] ?? CASES.rich;
          const size = Math.ceil(answer.length / STREAM_ANSWER_CHUNKS);
          for (let i = 0; i < answer.length; i += size) {
            c.enqueue(line({ type: 'answer_delta', text: answer.slice(i, i + size) }));
            await new Promise(r => setTimeout(r, gap));
          }
          c.enqueue(line({ type: 'done', answer, trace: STREAM_TRACE }));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    const body = broken
      ? BROKEN_RESPONSES[몇번째++ % BROKEN_RESPONSES.length]
      : { answer: CASES[which] ?? CASES.rich, trace: which === 'rich' ? TRACE : undefined };
    return new Response(JSON.stringify(body ?? null), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
