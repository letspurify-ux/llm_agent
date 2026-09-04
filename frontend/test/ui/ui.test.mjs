// 화면 동작의 회귀 테스트 — 실행: npm run test:ui (frontend/) · 단위 검사까지 함께: npm run test:all
//
// 여기서 지키는 것은 단위 테스트가 닿지 못하는 계약이다: 대화가 언제 따라 내려가고 언제 가만히
// 있는가, 좁은 화면에서 무엇이 잘리지 않는가, 인쇄에서 무엇이 풀리는가, 모델이 쓴 주소가 저절로
// 불려 나가지 않는가. 이 계약들은 깨져도 오류로 보이지 않는다 — 답의 끝이 입력창 뒤에 남거나,
// 읽던 표가 손 밑에서 달아나거나, 조각 이름이 소리 없이 사라질 뿐이다.
//
// 진짜 브라우저가 필요하다(레이아웃·스크롤 앵커링·ResizeObserver가 이 계약의 절반이다). Chrome이
// 없으면 건너뛴다 — 단위 테스트(npm test)는 그것과 무관하게 돈다.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep, STATE,
  alive, aliveGroup } from './driver.mjs';
import { pieSlices, parseChartBlock } from '../../src/chart.js';
import { TRACE, READY, PIE_BLOCK, LONG_URL, DATA_URL, MAIL_URL, CAPPED_LABEL, ERROR_LABEL,
  ANCHOR_URL, ANCHOR_TEXT, ANCHOR_IMG_TEXT, NESTED_LINK, 주소를_가리키는_링크 } from './fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = join(ROOT, 'ui-probe.html');

// 포트는 그때그때 빈 것을 받는다. 번호를 박아 두면 남의 개발 서버와 부딪혔을 때 검사가 실패로 남고,
// 앞선 실행이 남긴 브라우저가 있으면 이번에 띄운 것이 아니라 그것에 붙는다(디버깅 포트는 Chrome이
// 고른 뒤 프로필에 적어 주는 값을 읽는다 — driver.mjs chromePort).
let port; let vite; let chromeBin; let chrome; let profile; let page; let skip = null;
const url = (c = 'rich') => `http://localhost:${port}/ui-probe.html?case=${c}`;

before(async () => {
  chromeBin = await findChrome();
  if (!chromeBin) { skip = 'Chrome을 찾지 못해 UI 검사를 건너뜁니다 (CHROME_PATH로 지정할 수 있습니다)'; return; }
  // 화면 껍데기는 index.html 그대로 쓰고 진입점만 probe로 바꾼다 — CSS가 갈라지면 검사가 거짓말이 된다.
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  await writeFile(PROBE, html.replace('/src/main.jsx', '/test/ui/probe.jsx'));
  port = await freePort();
  // vite를 npx가 아니라 직접 띄운다 — npx를 거치면 부모가 바뀌어 이 검사 안에서 서버가 조용히 죽었다.
  vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: process.env.UI_DEBUG ? 'inherit' : 'ignore' });
  let viteError = null;
  vite.on('error', e => { viteError = e.message; });
  // 뜨지 못하는 길은 두 가지고, 듣지 않으면 둘 다 30초 뒤에 같은 말로 끝난다. 스스로 끝나는 쪽이
  // 흔하다 — freePort()가 준 번호를 그 사이에 남이 잡으면 --strictPort의 vite는 곧바로 나간다.
  vite.on('exit', (code, sig) => {
    viteError ??= `개발 서버가 곧바로 끝났습니다 (${sig ?? `code ${code}`}) — ${port} 포트를 남이 잡고 있을 수 있습니다`;
  });
  // 끊긴 실행(Ctrl-C)이나 아래에서 던지는 길에서는 after()가 돌지 않는다 — 그때도 띄운 것을 남기지 않는다.
  killOnExit(() => [{ proc: chrome, group: true }, { proc: vite }]);
  let up = false;
  for (let i = 0; i < 60 && !up && !viteError; i++) {   // 개발 서버가 뜰 때까지
    try { up = (await fetch(url())).ok; } catch { /* 아직 */ }
    if (!up) await sleep(500);
  }
  // Chrome이 없는 것만 '환경'이라 건너뛴다. 개발 서버가 뜨지 않는 것은 고쳐야 할 일이므로
  // 실패로 남긴다 — 건너뛰면 아무것도 검사하지 않은 채 초록불이 난다.
  if (!up) throw new Error(`개발 서버가 ${port} 포트에 뜨지 않았습니다${viteError ? `: ${viteError}` : ' (UI_DEBUG=1로 서버 로그를 볼 수 있습니다)'}`);
  // 브라우저는 개발 서버가 선 것을 보고 띄운다. Chrome의 디버깅 포트는 OS가 골라 주는데(=0), 그
  // 번호는 freePort()가 vite에게 건네준 번호와 같은 자리에서 나온다 — 아직 붙지 않은 vite의 포트를
  // Chrome이 집어 가면 vite가 --strictPort에서 그대로 죽는다. 순서를 두어 그 창을 닫는다.
  profile = await mkdtemp(join(tmpdir(), 'ui-chrome-'));
  chrome = launchChrome({ bin: chromeBin, profile });
  page = await Page.open((await oneTab(await chromePort(profile))).webSocketDebuggerUrl);
});

after(async () => {
  // 탭은 비워 두고(다음 실행이 이 탭을 다시 쓴다) 띄운 것들을 내린다.
  try { await page?.send('Page.navigate', { url: 'about:blank' }); } catch { /* 이미 닫혔다 */ }
  page?.ws?.close();          // 열어 둔 소켓 하나가 node를 끝나지 못하게 붙잡는다
  // 신호를 보내는 것으로 끝내지 않고 정말 끝났는지 확인한다 — 아니면 검사를 돌릴 때마다 브라우저가
  // 한 벌씩 남는다(driver.mjs stopProcess 주석). 프로필을 지우는 것도 그 뒤라야 한다: 내려앉는
  // 중에 폴더를 빼면 지우지도 못하고 Chrome만 더 붙든다.
  // 끝내 내려가지 않았다면 조용히 넘기지 않는다 — 그것이 바로 이 검사가 막으려던 상태다.
  // 여기서 던지면 시험이 모두 통과해도 파일 단위 실패가 되지만, 그것이 맞다: 콘솔 한 줄로 알리고
  // 초록불을 내면 CI도 사람도 성공만 보고, 검사를 돌릴 때마다 브라우저가 한 벌씩 쌓인다.
  // 치울 것을 모두 치운 뒤에 던진다 — 먼저 던지면 probe 파일과 프로필이 남는다.
  const 브라우저_내려감 = await stopProcess(chrome, { group: true });
  // 개발 서버도 같다: kill()은 신호일 뿐이라, 그대로 두면 포트를 쥔 서버가 한 벌씩 남는다.
  const 서버_내려감 = await stopProcess(vite);
  await rm(PROBE, { force: true });
  // 그래도 남은 것이 있으면 검사의 성패와는 무관하다(OS 임시 폴더다). 여기서 던지면 시험이 모두
  // 통과해도 파일 단위로 실패로 남는다.
  await rm(profile ?? '', { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  if (!브라우저_내려감) throw new Error(`Chrome(pid ${chrome?.pid})이 끝내 내려가지 않았습니다 — 브라우저가 한 벌 남았습니다`);
  if (!서버_내려감) throw new Error(`개발 서버(pid ${vite?.pid})가 끝내 내려가지 않았습니다 — 포트 ${port}를 쥔 채 남았습니다`);
});

// 시험이 일부러 낸 줄(귀가 열려 있는지 확인하는 자리)만 아래 afterEach가 걷어낸다. 낸 뒤에 로그를
// 비우는 것으로는 모자라다 — 브라우저는 막힌 그림 하나에 '정책 위반'과 '불러오지 못했다'를 따로,
// 순서도 정해지지 않은 채 내므로 비운 뒤에 온 한 줄이 애먼 시험의 실패가 된다.
let 일부러_낸_줄 = null;
// 콘솔에 오른 오류는 그것을 낸 시험의 이름과 함께 말한다. 마지막 시험 하나가 파일 전체의 로그를
// 몰아 보게 하면 어느 시험이 낸 것인지 말하지 못하고, 그 시험이 로그를 비우고 시작하면 앞의
// 시험들이 낸 것은 아무도 보지 않는다(React는 렌더의 문제를 예외가 아니라 console.error로 말한다).
afterEach(() => {
  const 남은 = (page?.logs?.splice(0) ?? []).filter(l => !일부러_낸_줄?.test(l));
  일부러_낸_줄 = null;
  assert.deepStrictEqual(남은, [], `콘솔에 오류가 올랐다: ${JSON.stringify(남은)}`);
});

// 답을 하나 받아 둔 화면에서 시작한다 (차트·흐름도가 자리를 잡을 때까지 기다린다).
async function answered(w = 1000, h = 760, { mobile = false, c = 'rich' } = {}) {
  await page.touchMode(mobile);
  await page.viewport(w, h, mobile);
  await page.goto(url(c), '.chip');
  await page.viewport(w, h, mobile);
  await page.eval(`document.querySelectorAll('.chip')[0].click()`);
  await page.until(READY[c], { what: `'${c}' 답변이 다 서기` });
  await settled();
}

// 화면이 잠잠해질 때까지. READY는 '자리를 잡기 시작했다'까지만 말한다 — 흐름도는 그 뒤에 글자
// 크기를 맞추며 한 번 더 커지고, 그렇게 자랄 때마다 따라가기(App.jsx glide, 350ms)가 다시 걸린다.
// 정해진 시간을 자면 느린 컴퓨터에서는 그 한가운데를 재게 되고, 6px을 다투는 검사가 애먼 패널을
// 탓하며 깨진다. 그래서 '두 번 연속 같은 자리'를 기다린다.
async function settled({ everyMs = 120, 연속 = 2, timeoutMs = 12_000 } = {}) {
  let prev = null; let same = 0; let last = null;
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
    last = await page.eval(`(() => { const el = document.querySelector('.chat');
      return el ? el.scrollTop + '/' + el.scrollHeight + '/' + document.body.scrollHeight : 'none'; })()`);
    same = last === prev ? same + 1 : 1;               // 이 자리를 몇 번 연속 보았는가
    prev = last;
    if (same >= 연속) return;
    await sleep(everyMs);
  }
  // 끝내 잠잠해지지 않으면 여기서 멈춘다. 알리기만 하고 지나가면 뒤의 검사들이 움직이는 화면을
  // 6px로 재면서 초록불을 내거나, 애먼 자리를 탓하며 깨진다.
  throw new Error(`화면이 ${timeoutMs}ms 안에 잠잠해지지 않았습니다 (마지막으로 본 자리: ${last})`);
}
const state = () => page.eval(STATE);
// 콘솔에 이런 줄이 오를 때까지 기다린다. 정해진 시간을 자면 느린 컴퓨터에서는 아직 오지 않은 것을
// '듣지 못했다'고 하고(로그는 evaluate의 답과 따로 오는 CDP 이벤트다) 빠른 곳에서는 남는 시간을
// 버린다 — 이 파일의 다른 기다림이 모두 page.until인 것과 같은 이유로 여기서도 기다린다.
async function 콘솔에_오를때까지(re, { timeoutMs = 8000, everyMs = 50 } = {}) {
  for (const t0 = Date.now(); ;) {
    if (page.logs.some(l => re.test(l))) return;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`시간 안에 콘솔에 오르지 않았습니다: ${re} (그동안 들은 것: ${JSON.stringify(page.logs)})`);
    await sleep(everyMs);
  }
}
// 뒤늦게 자리를 잡는 차트·흐름도를 흉내 낸다 (내용이 그만큼 자란다).
const grow = (px = 300) => page.eval(`(() => { const d = document.createElement('div');
  d.style.cssText = 'height:${px}px'; document.querySelector('.chat-inner').appendChild(d); return true; })()`);
// 화면에서 이 요소가 있는 자리 (scrollTop은 브라우저의 스크롤 앵커링이 보정하므로, '사용자가 보던
// 것이 움직였는가'는 요소의 화면 좌표로 재야 한다)
// (선택자는 JSON.stringify로 넣는다 — 따옴표를 직접 붙이면 a[href='…'] 같은 선택자가 페이지 안에서
// 문법 오류가 되어, 재는 대신 낯선 SyntaxError로 죽는다. driver.mjs goto도 같다.)
const seen = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
  return e ? Math.round(e.getBoundingClientRect().top) : null; })()`);
// Chrome이 없으면 그 자리에서 건너뛴다 (before가 돈 뒤에야 알 수 있으므로 시험 안에서 판단한다)
const it = (name, fn) => test(name, async t => { if (skip) return t.skip(skip); await fn(t); });

it('답이 오면 차트·흐름도가 뒤늦게 서도 끝까지 따라간다', async () => {
  await answered();
  assert.ok((await state()).rest < 8, '답의 끝이 입력창 뒤에 남았다');
});

it('두 번째 답을 받은 뒤에도 뒤늦게 커지는 것을 따라간다 (관찰자를 다시 다는 자리)', async () => {
  await answered();
  // 말풍선의 크기 변화를 보는 관찰자는 대화가 늘 때마다 다시 단다(App.jsx). 그 자리에서 관찰자가
  // 끊긴 채 남으면 첫 답만 보는 위 시험들은 그대로 통과하고, 두 번째 답부터 조용히 따라가기가
  // 멎는다 — 오류는 나지 않고 답의 끝이 입력창 뒤에 남을 뿐이다(실측 25~316px).
  // 앞서는 만드는 곳과 놓는 곳이 서로 다른 효과에 있어, 놓는 쪽 효과에 의존성이 하나 붙기만 해도
  // 그 상태가 되었다.
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Input.insertText', { text: '두 번째 질문' });   // 키 입력이 아닌 글자 넣기(IME·붙여넣기와 같은 길)
  await page.key('Enter', 'Enter', 13);
  await page.until(`document.querySelectorAll('.row.user').length === 2 && !document.querySelector('.typing')`,
    { what: '두 번째 답이 도착하기' });
  await settled();
  assert.ok((await state()).rest < 8, '두 번째 답의 끝이 입력창 뒤에 남았다');
  // 차트·흐름도가 그린 뒤에 자리를 잡는 것과 같은 모양 — 관찰자가 살아 있어야 여기를 따라간다.
  await grow(); await sleep(900);
  assert.ok((await state()).rest < 8, '두 번째 답 뒤로는 뒤늦게 커지는 것을 따라가지 못했다');
});

it('휠로 올려 읽는 중에는 뒤늦게 커져도 따라가지 않는다', async () => {
  await answered();
  await page.wheel(500, 400, -400);
  const up = await state();
  await grow(); await sleep(900);
  assert.strictEqual((await state()).top, up.top, '읽던 자리가 바닥으로 끌려갔다');
  // 바닥으로 되돌아가면 다시 붙는다
  await page.eval(`document.querySelector('.chat').scrollTop = 99999`); await sleep(400);
  await grow(); await sleep(900);
  assert.ok((await state()).rest < 8);
});

it('키보드로 올린 것도 사용자의 뜻이다 (keydown은 대화가 아니라 body에 떨어진다)', async () => {
  await answered();
  await page.eval(`document.querySelector('.chat').scrollTop = 99999`); await sleep(300);
  await page.press(500, 300); await sleep(600);        // 초점을 입력창 밖으로, 누름의 신호는 식히고
  const before = await state();
  for (let i = 0; i < 8; i++) await page.key('ArrowUp', 'ArrowUp', 38);
  await sleep(400);
  const up = await state();
  assert.ok(up.top < before.top - 20, '키보드로 대화가 올라가지 않았다');
  await grow(); await sleep(900);
  assert.ok(Math.abs((await state()).top - up.top) < 12, '키보드로 올린 자리가 바닥으로 끌려갔다');
});

it('입력 이벤트가 오지 않는 스크롤(찾기·파이어폭스 스크롤바)도 사용자의 뜻으로 본다', async () => {
  await answered();
  await page.eval(`document.querySelector('.chat').scrollTop = 99999`); await sleep(300);
  await page.eval(`document.querySelector('.chat').scrollTop -= 300`); await sleep(300);
  const up = await state();
  await grow(); await sleep(900);
  assert.ok(Math.abs((await state()).top - up.top) < 12, '입력 없이 올라간 자리를 바닥으로 되돌렸다');
});

it('그냥 누른 것(클릭·손떨림)은 따라가기를 끊지 않는다', async () => {
  await answered();
  // 화면 위쪽이 줄고 아래쪽이 자라는 한 프레임 — 브라우저가 스스로 자리를 옮기는 상황이다
  await page.eval(`(() => { const inner = document.querySelector('.chat-inner');
    const t = document.createElement('div'); t.style.cssText = 'height:500px'; t.id = 'shrinkme';
    inner.insertBefore(t, inner.firstChild); return true; })()`);
  await sleep(400);
  await page.eval(`document.querySelector('.chat').scrollTop = 99999`); await sleep(300);
  await page.press(500, 300, { move: 2 });             // 누른 채 2px 흔들린다
  await page.eval(`(() => { document.getElementById('shrinkme').style.height = '100px';
    const d = document.createElement('div'); d.style.cssText = 'height:600px';
    document.querySelector('.chat-inner').appendChild(d); return true; })()`);
  await sleep(1500);
  assert.ok((await state()).rest < 8, '클릭 한 번에 따라가기가 끊겼다');
});

it('창 크기를 바꿔도 바닥에 붙어 있다', async () => {
  await answered();
  await page.viewport(760, 560); await sleep(700);
  assert.ok((await state()).rest < 8, '창을 줄이자 답의 끝이 가려졌다');
  await page.viewport(1000, 760); await sleep(700);
  assert.ok((await state()).rest < 8, '창을 늘리자 바닥에서 떨어졌다');
});

it('비어 있는 첫 화면은 크기가 바뀌어도 맨 위로 튕기지 않는다', async () => {
  await page.viewport(420, 380);
  await page.goto(url(), '.chip');
  await page.viewport(420, 380);
  await page.eval(`document.querySelector('.chat').scrollTop = 9999`); await sleep(300);
  const down = await state();
  assert.ok(down.top > 10, '첫 화면이 넘치지 않아 이 검사가 성립하지 않는다');
  await page.viewport(420, 360); await sleep(700);     // 창을 줄인다
  assert.strictEqual((await state()).top, down.top, '예시 칩을 보려고 내려 둔 화면이 맨 위로 튕겼다');
});

it('펼침(⚡ 실행된 쿼리·표로 보기)은 보던 화면을 그대로 둔다', async () => {
  await answered();
  const before = await seen('details.trace > summary');
  assert.ok(before !== null, '⚡ 패널이 없다 (검사의 전제)');
  await page.eval(`document.querySelector('details.trace > summary').click()`);
  await sleep(900);
  const after = await state();
  assert.ok(after.rest > 100, '펼치자 바닥으로 끌려가 패널의 끝이 보인다');
  // 바닥으로 끌려가지 않았다는 것만으로는 모자란다 — 위로 밀려 올라가도 읽던 자리는 잃는다.
  assert.ok(Math.abs((await seen('details.trace > summary')) - before) < 6, '펼치자 패널의 머리가 화면에서 움직였다');
  // '표로 보기'는 화면 안에 있는 것을 펼쳐 본다 — 보던 자리가 그대로여야 한다
  await page.eval(`document.querySelector('.md .chart-table > summary').scrollIntoView({ block: 'center' })`);
  await sleep(600);
  const sum = await seen('.md .chart-table > summary');
  await page.eval(`document.querySelector('.md .chart-table > summary').click()`);
  await sleep(900);
  assert.ok(Math.abs((await seen('.md .chart-table > summary')) - sum) < 6, '펼치자 보던 자리가 움직였다');
});

it('표를 굴리는 동안에는 멈추고, 손을 뗀 여운이 지나면 밀린 것을 따라잡는다', async () => {
  await answered();
  await page.eval(`document.querySelector('details.trace > summary').click()`); await sleep(900);
  await page.eval(`document.querySelector('.chat').scrollTop = 99999`); await sleep(500);
  const grid = await page.eval(`(() => {
    const chat = document.querySelector('.chat').getBoundingClientRect();
    for (const e of document.querySelectorAll('.trace-grid')) {
      const r = e.getBoundingClientRect();
      const vis = Math.min(r.bottom, chat.bottom) - Math.max(r.top, chat.top);
      if (vis > 60) return { x: Math.round(r.left + 80), y: Math.round(Math.max(r.top, chat.top) + 25) };
    }
    return null; })()`);
  assert.ok(grid, '바닥에 붙은 채 보이는 표가 없다 (검사의 전제)');
  const before = await seen('.trace-step');
  await page.wheel(grid.x, grid.y, 0, 120);            // 표를 가로로 굴린다
  await grow(); await sleep(350);                      // 여운(App.jsx BUSY_MS = 600ms) 안
  assert.ok(Math.abs((await seen('.trace-step')) - before) < 12, '읽던 표가 손 밑에서 달아났다');
  await sleep(1200);                                   // 여운이 지난 뒤
  assert.ok((await state()).rest < 8, '미룬 것을 영영 갚지 않아 답의 끝이 가려졌다');
});

it('⚡ 패널은 상한에 걸린 건수와 오류를 문구로 밝힌다', async () => {
  await answered();
  await page.eval(`document.querySelector('details.trace > summary').click()`);
  // .trace-step은 패널이 접혀 있어도 이미 DOM에 있다(TracePanel이 늘 그린다) — 그것을 기다리면
  // 기다리지 않은 것과 같다. 표는 펼친 뒤에야 붙으므로(showGrid), 그것으로 '열렸다'를 확인한다.
  await page.until(`document.querySelector('details.trace')?.open && document.querySelectorAll('.trace-grid').length > 0`,
    { what: '⚡ 패널이 열리고 표가 붙기' });
  const got = await page.eval(`(() => ({
    요약: document.querySelector('details.trace > summary').textContent,
    건수: [...document.querySelectorAll('.trace-count')].map(e => e.textContent),
    표: document.querySelectorAll('.trace-grid').length,
    내려받기: document.querySelectorAll('.trace-csv').length,
  }))()`);
  assert.ok(got.요약.includes(`${TRACE.length}건`), `요약이 스텝 수를 잘못 말한다: ${got.요약}`);
  assert.ok(got.건수.includes(CAPPED_LABEL), `상한에 걸린 결과를 그대로 전부로 보여준다: ${JSON.stringify(got.건수)}`);
  assert.ok(got.건수.includes(ERROR_LABEL), `실행되지 못한 스텝이 오류를 밝히지 않는다: ${JSON.stringify(got.건수)}`);
  assert.ok(!got.건수.some(t => /undefined|NaN/.test(t)), `건수 문구에 값이 새어 나왔다: ${JSON.stringify(got.건수)}`);
  // 행이 없는(오류) 스텝에는 표도 내려받기도 없다 — 빈 표는 '0건 조회 성공'으로 읽힌다.
  // 몇 개여야 하는지는 픽스처에 묻는다: '하나만 빼고'라고 적어 두면 오류 스텝을 하나 더한 날
  // 맞게 그린 화면을 두고 검사가 깨진다(그러면 임자는 앱이 아니라 이 줄이다).
  const 행있는스텝 = TRACE.filter(t => t.rows?.length > 0).length;
  assert.ok(행있는스텝 < TRACE.length, '행 없는 스텝이 픽스처에 없다 (검사의 전제)');
  assert.strictEqual(got.표, 행있는스텝, '행 없는 스텝에 빈 표가 생겼다');
  assert.strictEqual(got.내려받기, 행있는스텝, '행 없는 스텝에 CSV 단추가 생겼다');
});

it('좁은 화면: 원그래프 조각이 잘리지 않고 이름은 그래프 밖 범례에 온전히 남는다', async () => {
  await answered(360, 800, { mobile: true });
  const pie = await page.eval(`(() => {
    const fig = document.querySelectorAll('figure.chart')[0];
    const box = fig.getBoundingClientRect();
    const svg = fig.querySelector('.recharts-surface').getBoundingClientRect();
    const sectors = [...fig.querySelectorAll('.recharts-pie-sector path')].map(p => p.getBoundingClientRect());
    const legend = fig.querySelector('.chart-legend');
    return {
      조각: sectors.length,
      잘림: sectors.some(r => r.left < svg.left - 1 || r.right > svg.right + 1 || r.top < svg.top - 1 || r.bottom > svg.bottom + 1),
      범례: legend ? [...legend.querySelectorAll('li')].map(li => li.textContent) : null,
      범례가_그래프밖: legend ? legend.getBoundingClientRect().top >= svg.bottom - 1 : false,
      말풍선밖: legend ? [...legend.querySelectorAll('li')].some(li => li.getBoundingClientRect().right > box.right + 1) : false,
    }; })()`);
  // 몇 조각이 되는지는 화면이 실제로 그리는 그 길에 물어본다: 픽스처의 블록 원문을 진짜 파서에
  // 넣고(parseChartBlock) 진짜 규칙으로 자른다(pieSlices). 여기서 행 모양이나 상한 계산을 손으로
  // 지어내면, 그것은 앱의 규칙을 검사가 한 벌 더 구현한 것이라 어느 날 조용히 갈라선다.
  const 몫들 = pieSlices(parseChartBlock(PIE_BLOCK).spec.rows);
  assert.strictEqual(pie.조각, 몫들.length);
  assert.ok(!pie.잘림, '원이 상자 밖으로 밀려 잘렸다');
  assert.strictEqual(pie.범례?.length, 몫들.length, '이름을 말할 범례가 없다');
  // 상한을 넘겨 둔 픽스처가 실제로 '기타'의 길을 밟았는가 — 밟지 않았다면 이 검사는 좁은 화면의
  // 절반(모아 놓은 조각)을 한 번도 보지 않은 것이다.
  assert.ok(pie.범례.some(t => t.startsWith('기타')), `'기타'로 모으는 길을 밟지 않았다: ${JSON.stringify(pie.범례)}`);
  assert.ok(pie.범례가_그래프밖, '범례가 그래프 몫의 높이를 먹고 있다');
  assert.ok(!pie.말풍선밖);
  assert.ok(!pie.범례.some(t => t.endsWith('…')), '범례 이름이 잘렸다');
  assert.strictEqual(await page.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0);
});

it('좁은 화면: 흐름도 글자가 읽히는 크기로 남고, 인쇄에서는 그 최소 폭이 풀린다', async () => {
  await answered(360, 800, { mobile: true });
  const screen = await page.eval(`(() => { const svg = document.querySelector('.mermaid svg');
    const h = [...svg.querySelectorAll('tspan')].map(t => t.getBoundingClientRect().height).filter(v => v > 0);
    return { 글자: Math.min(...h), minWidth: svg.style.minWidth }; })()`);
  assert.ok(screen.글자 >= 9, `흐름도 글자가 ${screen.글자}px로 남았다`);   // Mermaid.jsx MIN_LABEL_PX
  await page.media('print');
  const paper = await page.eval(`(() => { const box = document.querySelector('.mermaid'); const svg = box.querySelector('svg');
    return { minWidth: getComputedStyle(svg).minWidth, 넘침: Math.round(svg.getBoundingClientRect().width - box.clientWidth) }; })()`);
  await page.media('screen');
  assert.strictEqual(paper.minWidth, '0px', '종이에서도 최소 폭이 걸려 오른쪽이 잘린다');
  assert.ok(paper.넘침 <= 1);
});

it('인쇄물에서 답변 안의 넓은 표가 소리 없이 잘리지 않는다', async () => {
  // 종이에는 가로 스크롤이 없다 — 화면에서 넓은 표를 가두는 overflow-x가 종이에서는 그대로
  // '오른쪽을 버린다'가 되고, 그러고도 아무 표시가 남지 않는다(실측: 열 14개 표의 오른쪽 587px).
  // 조회 결과 표(.trace-grid)는 잘린다는 것을 안내로 밝히고 전체를 CSV로 넘기지만, 답변 안의
  // 표에는 그런 출구가 없다 — 여기서 잘린 값은 어디에서도 볼 수 없다.
  await answered(1000, 760, { c: 'wideprint' });
  const 재기 = `(() => { const t = document.querySelector('.md table');
    return { 잘림: Math.round(t.scrollWidth - t.clientWidth),
             밖으로: Math.round(t.getBoundingClientRect().right - document.querySelector('.chat-inner').getBoundingClientRect().right) }; })()`;
  const 화면 = await page.eval(재기);
  // 전제: 화면에서는 이 표가 실제로 넘쳐 가로 스크롤에 갇혀 있어야 한다 (넘치지 않으면 아무것도 재지 않는다)
  assert.ok(화면.잘림 > 50, `화면에서 표가 넘치지 않아 이 검사가 성립하지 않는다 (${화면.잘림}px)`);
  await page.media('print');
  const 종이 = await page.eval(재기);
  await page.media('screen');
  assert.ok(종이.잘림 <= 1, `인쇄물에서 표의 오른쪽 ${종이.잘림}px이 잘렸다 — 그 값은 어디에서도 볼 수 없다`);
  assert.ok(종이.밖으로 <= 1, `표가 종이의 열 밖으로 ${종이.밖으로}px 나갔다 — 그만큼은 여백에 잘린다`);
  // 화면은 지금까지 그대로여야 한다 — 종이를 고치려다 화면의 표가 한 글자 폭으로 접히면 안 된다
  assert.strictEqual((await page.eval(재기)).잘림, 화면.잘림, '인쇄 미디어를 다녀온 뒤 화면의 표가 달라졌다');
});

it('조합 확정으로 보낸 질문은 입력창에 남지 않는다 (마지막 input이 compositionend 뒤에 오는 브라우저)', async () => {
  // 한글은 마지막 글자가 늘 조합 중이라 Enter 전송은 거의 언제나 조합 확정을 거친다. 그런데 확정의
  // 마지막 input 이벤트가 compositionend '앞'에 오는 브라우저와 '뒤'에 오는 브라우저가 갈린다 —
  // 뒤에 오는 쪽에서는 그 이벤트가 아직 지워지지 않은 입력창(DOM)의 값을 읽어, 전송이 방금 비운
  // state를 보낸 글자로 되돌린다. 보낸 질문이 입력창에 그대로 남고, 사용자가 Enter를 한 번 더
  // 누르면 같은 질문이 두 번 나간다(실측: 그 순서로 이벤트를 내자 그대로 재현됐다).
  // 헤드리스 Chrome의 IME는 앞에 오는 순서만 내주므로 이벤트를 그 순서로 직접 낸다. 값을 넣는
  // 길(네이티브 setter + input 이벤트)은 아래 '긴 초안' 시험과 같다 — React가 그 변화를 보는 길이다.
  await page.goto(url(), '.chip');
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    set.call(ta, '한'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 조합 중의 Enter는 IME가 먼저 받으므로 keyCode 229로 온다 (App.jsx가 그것으로 조합을 알아본다)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    set.call(ta, '한글');
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }));
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // 확정의 마지막 input — compositionend '뒤'다
    return true; })()`);
  await page.until(`document.querySelectorAll('.row.user').length === 1`, { what: '조합 확정으로 보낸 질문이 서기' });
  assert.strictEqual(await page.eval(`document.querySelector('.row.user .bubble').textContent`), '한글',
    '조합 중이던 마지막 글자가 빠진 채 나갔다');
  assert.strictEqual(await page.eval(`document.querySelector('.composer textarea').value`), '',
    '보낸 질문이 입력창에 그대로 남았다');
  // 남지 않는다는 것을 결과로도 못 박는다 — 그것이 사용자가 겪는 손해다(같은 질문이 두 번 나간다).
  await page.until(`!document.querySelector('.typing')`, { what: '답이 도착하기' });
  await settled();
  await page.key('Enter', 'Enter', 13);
  await sleep(500);
  assert.strictEqual(await page.eval(`document.querySelectorAll('.row.user').length`), 1,
    '보낸 뒤 다시 누른 Enter가 같은 질문을 한 번 더 보냈다');
});

it('낮은 화면에서 긴 초안이 대화를 잡아먹지 않는다', async () => {
  await answered(390, 740, { mobile: true });
  await page.viewport(390, 380, true); await sleep(500);
  await page.eval(`(() => { const ta = document.querySelector('.composer textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, Array.from({ length: 12 }, (_, i) => '초안 ' + (i + 1) + '번째 줄').join('\\n'));
    ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(600);
  const box = await page.eval(`(() => { const ta = document.querySelector('.composer textarea');
    const send = document.querySelector('.send').getBoundingClientRect();
    return { 입력창: Math.round(ta.getBoundingClientRect().height),
      대화: Math.round(document.querySelector('.chat').getBoundingClientRect().height),
      단추가_화면안: send.bottom <= innerHeight + 1 }; })()`);
  assert.ok(box.입력창 <= 160, `입력창이 ${box.입력창}px까지 자랐다`);   // index.html의 .composer textarea max-height
  assert.ok(box.대화 > 60, '대화가 0px으로 눌렸다');
  assert.ok(box.단추가_화면안, '보내기 단추가 창 밖으로 나갔다');
});

it('모델이 쓴 주소는 저절로 불려 나가지 않는다 (그림·흐름도 라벨·차트 표의 셀)', async () => {
  // tableimg는 차트 블록의 표다. 그쪽 파이프라인은 그림 주소를 원문 그대로 넘기므로(App.jsx
  // mdProps의 urlTransform) TABLE_MD의 img 하나가 유일한 관문이다 — 본문과 따로 확인해야 한다.
  for (const c of ['images', 'mermaidhtml', 'tableimg']) {
    await answered(900, 760, { c });
    const got = await page.eval(`(() => ({
      요청: performance.getEntriesByType('resource').map(e => e.name).filter(n => /__probe-pixel/.test(n)).length,
      img: document.querySelectorAll('.md img, .mermaid img').length,
      중첩앵커: !!document.querySelector('.md a a'),
    }))()`);
    assert.strictEqual(got.요청, 0, `${c}: 주소가 저절로 불려 나갔다`);
    assert.strictEqual(got.img, 0, `${c}: <img>가 만들어졌다`);
    assert.ok(!got.중첩앵커, `${c}: 링크 안에 링크가 생겼다`);
  }
  // 열어 주지 않았을 뿐, 셀이 무엇을 가리키는지는 남아야 한다 (표에서도 본문과 같은 모양이다)
  const 셀 = await page.eval(`(() => { const a = [...document.querySelectorAll('.md table a')]
    .find(a => /__probe-pixel/.test(a.getAttribute('href') ?? ''));
    return a ? { 글자: a.textContent, 새탭: a.getAttribute('target') } : null; })()`);
  assert.ok(셀, '차트 표의 셀에서 그림 주소가 통째로 사라졌다 — 무엇을 열지 않았는지도 알 수 없다');
  assert.strictEqual(셀.새탭, '_blank', '표 안의 링크가 같은 탭에서 열린다 — 대화가 통째로 사라진다');
});

it('페이지 안 앵커는 그림이든 링크든 제자리에서 연다', async () => {
  // 같은 자리를 가리키는 주소를 그림 자리와 링크 자리가 다르게 판정하면, 한쪽은 대화 없는 앱을
  // 한 벌 더 띄운다. 두 자리가 같은 규칙(markdown.js isInPage)을 쓰는지 화면에서 확인한다.
  await answered(900, 760, { c: 'images' });
  const got = await page.eval(`(() => {
    const 앵커 = [...document.querySelectorAll('.md a')].filter(a => a.getAttribute('href') === ${JSON.stringify(ANCHOR_URL)});
    return {
      수: 앵커.length,
      새탭: 앵커.map(a => a.getAttribute('target')),
      글자: 앵커.map(a => a.textContent).join(' | '),
      바깥: document.querySelector(${주소를_가리키는_링크(NESTED_LINK)})?.getAttribute('target') ?? null,
    }; })()`);
  assert.strictEqual(got.수, 2, `앵커를 가리키는 링크와 그림이 둘 다 남지 않았다: ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got.새탭, [null, null], `페이지 안 앵커를 새 탭에서 연다: ${JSON.stringify(got)}`);
  assert.ok(got.글자.includes(ANCHOR_TEXT) && got.글자.includes(ANCHOR_IMG_TEXT), `앵커의 글자가 사라졌다: ${got.글자}`);
  // 반대쪽도 함께 못 박는다 — 바깥 주소까지 제자리에서 열면 대화가 통째로 사라진다
  assert.strictEqual(got.바깥, '_blank', '바깥 주소가 같은 탭에서 열린다');
});

it('열어 주지 않는 주소도 무엇인지 밝히고, 긴 주소가 답변을 덮지 않는다', async () => {
  await answered(900, 760, { c: 'images' });
  const got = await page.eval(`(() => {
    const long = [...document.querySelectorAll('.md a')].find(a => a.getAttribute('href') === ${JSON.stringify(LONG_URL)});
    const 글자 = [...document.querySelectorAll('.md em')].map(e => e.textContent);
    return {
      긴것_글자수: long ? long.textContent.length : null,
      긴것_주소: long ? long.getAttribute('href') : null,
      data: 글자.find(t => t.includes('data:')) ?? null,
      mailto: 글자.find(t => t.includes('mailto:')) ?? null,
      가로넘침: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }; })()`);
  assert.ok(got.긴것_글자수 !== null, '긴 주소가 링크로 남지 않았다 (검사의 전제)');
  // 글자로 펴지는 것은 줄이고(clip 60자 + '🖼 '), 주소 자체는 픽스처 그대로 온전히 남는다
  assert.ok(got.긴것_글자수 <= 70, `링크 글자가 ${got.긴것_글자수}자까지 펴져 답변이 주소에 묻혔다 (주소는 ${LONG_URL.length}자)`);
  assert.strictEqual(got.긴것_주소, LONG_URL, '주소가 href에서도 잘렸다');
  // data:·mailto:는 열어 주지 않는다 — 그래도 무엇을 가리키는지는 남아야 한다(react-markdown의
  // 기본 규칙은 이 주소들을 빈 문자열로 지운다. markdown.js mdUrlTransform)
  assert.ok(got.data?.includes(DATA_URL.slice(0, 40)), `data: 그림이 무엇을 가리키는지 사라졌다: ${got.data}`);
  assert.ok(got.mailto?.includes(MAIL_URL), `mailto: 그림이 무엇을 가리키는지 사라졌다: ${got.mailto}`);
  assert.strictEqual(got.가로넘침, 0, '긴 주소가 화면을 가로로 밀어냈다');
});

it('띄운 브라우저는 끝나면 정말 사라지고, 끊긴 연결은 기다리던 요청을 놓아준다', async () => {
  // 검사를 한 번 돌릴 때마다 브라우저가 한 벌씩 남으면 개발자의 컴퓨터가 몇 번 만에 잠긴다.
  // kill()은 신호를 보낼 뿐이라, 앱을 띄운 headless Chrome은 그것 하나로는 내려가지 않는다.
  const dir = await mkdtemp(join(tmpdir(), 'ui-chrome-stop-'));
  const proc = launchChrome({ bin: chromeBin, profile: dir });
  let p;
  try {
    p = await Page.open((await oneTab(await chromePort(dir))).webSocketDebuggerUrl);
    await p.goto(url(), '.chip');        // 빈 화면은 신호 하나로도 내려간다 — 앱이 선 브라우저라야 한다
    const 매달린요청 = p.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true });
    매달린요청.catch(() => {});   // 아직 볼 차례가 아닐 뿐이다 — 처리되지 않은 거절로 node를 깨우지 않게
    assert.ok(await stopProcess(proc, { group: true }), '브라우저가 신호를 받고도 끝나지 않았다');
    assert.strictEqual(alive(proc.pid), false, `Chrome(pid ${proc.pid})이 검사 뒤에도 살아 있다`);
    // 남는 것은 우두머리만이 아니다 — 렌더러·GPU 도우미 하나가 살아 있어도 그룹은 남고, 그것이
    // 지운 프로필 폴더를 붙들고 있던 실제 모습이었다.
    assert.strictEqual(aliveGroup(proc.pid), false, `Chrome의 도우미 프로세스가 남았다 (그룹 ${proc.pid})`);
    // 연결이 끊기면 기다리던 요청은 영영 답을 받지 못한다 — 거절하지 않으면 검사가 실패도 아니고
    // 끝나지도 않는다(node:test에는 기본 시간 제한이 없다).
    // 무엇으로 거절했는지까지 남긴다 — 어쩌다 한 번 어긋나는 자리는 메시지가 없으면 다시 잡기 어렵다.
    const 거절 = await 매달린요청.then(() => '거절하지 않고 값을 돌려주었다', e => e.message);
    assert.match(거절, /연결/, `연결이 끊겼는데 기다리던 요청이 그대로 매달렸다: ${거절}`);
  } finally {
    p?.ws?.close();   // 열어 둔 소켓 하나가 node를 끝나지 못하게 붙잡는다 (after()가 본체에 하는 것과 같다)
    await stopProcess(proc, { group: true });
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
});

it('화면을 옮겨 가는 기다림은 새 화면이 실제로 설 때까지 기다린다', async () => {
  // 기다리는 조건(.chip 등)이 두 화면에 다 있으면, 옮겨 가기 전 문서에서 곧바로 참이 된다 —
  // 그러면 시간만 재던 때와 똑같이 곧 사라질 문서를 만지게 되고, 그 실패는 느린 컴퓨터에서만 난다.
  // 문서가 바뀌었는지만 보면 모자란다: 새 문서는 곧바로 생기고 앱은 그 뒤에 선다. 그래서 앱이
  // 늦게 서는 화면(?slow=)으로 옮겨 가, 그 기다림이 앱까지 기다리는지 시간으로 잰다.
  await answered();
  await page.eval(`window.__이전문서표시 = true`);
  const 늦게 = 1200;
  const t0 = Date.now();
  await page.goto(`${url('mermaidhtml')}&slow=${늦게}`, '.chip');
  const 걸린 = Date.now() - t0;
  assert.strictEqual(await page.eval(`window.__이전문서표시 ?? null`), null, '옮겨 가기 전 문서에서 돌아왔다');
  assert.strictEqual(await page.eval(`!!document.querySelector('.chip')`), true, '돌아왔는데 화면이 서 있지 않다');
  assert.ok(걸린 >= 늦게 * 0.8, `앱이 서기도 전에 돌아왔다 (${걸린}ms < ${늦게}ms)`);
});

it('기다림은 오타를 곧바로 알리고, 지나가는 오류는 그 글자에 속지 않는다', async () => {
  // 못 읽는 식·없는 이름은 기다린다고 달라지지 않지만(검사를 쓴 사람의 오타), 화면이 서는 중의
  // TypeError는 다음 폴링에서 풀린다(아직 없는 요소를 만지는 일). 그 둘을 오류 메시지 전체로
  // 가르던 때에는 'ReferenceError'라는 글자가 스택이나 앱이 낸 문자열에 섞이기만 해도 지나가는
  // 오류가 치명이 되어, 통과했을 검사가 애먼 말과 함께 죽었다 — 이름으로 가른다(driver.mjs errorName).
  일부러_낸_줄 = /ReferenceError|TypeError/;   // 여기서 내는 오류가 afterEach의 것으로 읽히지 않게
  await page.goto(url(), '.chip');
  const t0 = Date.now();
  await assert.rejects(page.until('__없는이름__()', { timeoutMs: 6000 }), /ReferenceError/,
    '없는 이름(오타)을 시간 끝까지 기다렸다');
  assert.ok(Date.now() - t0 < 3000, `오타를 ${Date.now() - t0}ms나 기다렸다 — 그 말은 늦게 나오는 만큼 흐려진다`);
  // 이름은 TypeError인데 메시지에 'ReferenceError'가 섞인 오류. 지나가는 것으로 보고 기다려야 하므로,
  // 여기서는 그 오류가 아니라 '시간 안에 이루어지지 않았다'로 끝나는 것이 맞다.
  const t1 = Date.now();
  await assert.rejects(
    page.until(`(() => { throw new TypeError('ReferenceError: 흉내') })()`, { timeoutMs: 1200, what: '오지 않을 조건' }),
    /시간 안에 이루어지지 않았습니다/, '지나가는 TypeError를 그 글자만 보고 치명으로 읽었다');
  assert.ok(Date.now() - t1 >= 1000, '기다리지 않고 곧바로 나왔다');
});

it('렌더링 중 콘솔에 예외도 오류도 오르지 않는다', async () => {
  // 로그는 시험마다 afterEach가 확인하고 비운다 — 이 시험이 보는 것은 아래 네 화면이 낸 것뿐이다.
  for (const c of ['rich', 'images', 'mermaidhtml', 'tableimg']) await answered(1000, 760, { c });
  assert.deepStrictEqual(page.logs, []);
  // 듣고 있다는 것까지 확인한다 — 귀를 닫은 검사는 무엇이 나가도 늘 통과한다(React는 렌더의
  // 문제를 예외가 아니라 console.error로 말하므로, 그 귀가 이 검사의 전부다).
  // 이 아래로는 일부러 오류를 낸다 — 그 줄까지 afterEach가 '아무도 내지 않은 오류'로 읽지 않게 밝혀 둔다.
  일부러_낸_줄 = /들려야 하는 줄|__csp-probe/;
  await page.eval(`console.error('들려야 하는 줄')`);
  await 콘솔에_오를때까지(/들려야 하는 줄/)
    .catch(() => assert.fail('콘솔에 오른 오류를 듣지 못한다 — 이 검사는 아무것도 보지 않는다'));
  // 브라우저가 스스로 내는 오류(CSP 위반·불러오지 못한 자원)는 console API를 거치지 않으므로 그
  // 귀는 따로 있다(driver.mjs의 Log 도메인). 닫아 두면 index.html의 img-src 방어선이 실제로 걸려도
  // 이 검사는 아무것도 보지 못한다 — 확인해 보니 그때 page.logs는 비어 있었다.
  // 그 귀와 방어선을 한 번에 확인한다: 화면 밖 주소의 그림은 막히고, 막혔다는 말이 들려야 한다.
  await page.eval(`(() => { const i = document.createElement('img');
    i.src = 'https://ex.test/__csp-probe.png'; document.body.appendChild(i); return true; })()`);
  await 콘솔에_오를때까지(/Content Security Policy/)
    .catch(e => assert.fail(`브라우저가 낸 오류를 듣지 못한다 — 그림 정책이 걸려도 이 검사는 보지 못한다: ${e.message}`));
});
