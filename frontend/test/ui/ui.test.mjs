// 화면 동작의 회귀 테스트 — 실행: npm run test:ui (frontend/)
//
// 여기서 지키는 것은 단위 테스트가 닿지 못하는 계약이다: 대화가 언제 따라 내려가고 언제 가만히
// 있는가, 좁은 화면에서 무엇이 잘리지 않는가, 인쇄에서 무엇이 풀리는가, 모델이 쓴 주소가 저절로
// 불려 나가지 않는가. 이 계약들은 깨져도 오류로 보이지 않는다 — 답의 끝이 입력창 뒤에 남거나,
// 읽던 표가 손 밑에서 달아나거나, 조각 이름이 소리 없이 사라질 뿐이다.
//
// 진짜 브라우저가 필요하다(레이아웃·스크롤 앵커링·ResizeObserver가 이 계약의 절반이다). Chrome이
// 없으면 건너뛴다 — 단위 테스트(npm test)는 그것과 무관하게 돈다.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, oneTab, Page, sleep, STATE } from './driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 51_997;         // 개발 서버(5173)와 겹치지 않게
const CDP_PORT = 51_998;
const PROBE = join(ROOT, 'ui-probe.html');
const url = (c = 'rich') => `http://localhost:${PORT}/ui-probe.html?case=${c}`;

let vite; let chrome; let profile; let page; let skip = null;

before(async () => {
  const bin = await findChrome();
  if (!bin) { skip = 'Chrome을 찾지 못해 UI 검사를 건너뜁니다 (CHROME_PATH로 지정할 수 있습니다)'; return; }
  // 화면 껍데기는 index.html 그대로 쓰고 진입점만 probe로 바꾼다 — CSS가 갈라지면 검사가 거짓말이 된다.
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  await writeFile(PROBE, html.replace('/src/main.jsx', '/test/ui/probe.jsx'));
  // vite를 npx가 아니라 직접 띄운다 — npx를 거치면 부모가 바뀌어 이 검사 안에서 서버가 조용히 죽었다.
  vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: process.env.UI_DEBUG ? 'inherit' : 'ignore' });
  vite.on('error', e => { skip = `개발 서버를 띄우지 못했습니다: ${e.message}`; });
  profile = await mkdtemp(join(tmpdir(), 'ui-chrome-'));
  chrome = launchChrome({ bin, port: CDP_PORT, profile });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {                 // 개발 서버가 뜰 때까지
    try { up = (await fetch(url())).ok; } catch { /* 아직 */ }
    if (!up) await sleep(500);
  }
  if (!up) { skip = '개발 서버가 뜨지 않아 UI 검사를 건너뜁니다'; return; }
  page = await Page.open((await oneTab(CDP_PORT)).webSocketDebuggerUrl);
});

after(async () => {
  // 탭은 비워 두고(다음 실행이 이 탭을 다시 쓴다) 띄운 것들을 내린다.
  try { await page?.send('Page.navigate', { url: 'about:blank' }); } catch { /* 이미 닫혔다 */ }
  page?.ws?.close();          // 열어 둔 소켓 하나가 node를 끝나지 못하게 붙잡는다
  chrome?.kill(); vite?.kill();
  await rm(PROBE, { force: true });
  // 프로필 폴더는 Chrome이 내려앉는 동안 아직 쓰고 있다 — 지우지 못해도 검사의 성패와는 무관하다
  // (OS 임시 폴더다). 여기서 던지면 시험이 모두 통과해도 파일 단위로 실패로 남는다.
  await sleep(300);
  await rm(profile ?? '', { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

// 답을 하나 받아 둔 화면에서 시작한다 (차트·흐름도가 자리를 잡을 때까지 기다린다).
async function answered(w = 1000, h = 760, { mobile = false, c = 'rich' } = {}) {
  await page.touchMode(mobile);
  await page.viewport(w, h, mobile);
  await page.goto(url(c));
  await page.viewport(w, h, mobile);
  await page.eval(`document.querySelectorAll('.chip')[0].click()`);
  await sleep(3500);
}
const state = () => page.eval(STATE);
// 뒤늦게 자리를 잡는 차트·흐름도를 흉내 낸다 (내용이 그만큼 자란다).
const grow = (px = 300) => page.eval(`(() => { const d = document.createElement('div');
  d.style.cssText = 'height:${px}px'; document.querySelector('.chat-inner').appendChild(d); return true; })()`);
// 화면에서 이 요소가 있는 자리 (scrollTop은 브라우저의 스크롤 앵커링이 보정하므로, '사용자가 보던
// 것이 움직였는가'는 요소의 화면 좌표로 재야 한다)
const seen = sel => page.eval(`(() => { const e = document.querySelector('${sel}');
  return e ? Math.round(e.getBoundingClientRect().top) : null; })()`);
// Chrome이 없으면 그 자리에서 건너뛴다 (before가 돈 뒤에야 알 수 있으므로 시험 안에서 판단한다)
const it = (name, fn) => test(name, async t => { if (skip) return t.skip(skip); await fn(t); });

it('답이 오면 차트·흐름도가 뒤늦게 서도 끝까지 따라간다', async () => {
  await answered();
  assert.ok((await state()).rest < 8, '답의 끝이 입력창 뒤에 남았다');
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
  await page.goto(url());
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
  await page.eval(`document.querySelector('details.trace > summary').click()`);
  await sleep(900);
  const after = await state();
  assert.ok(after.rest > 100, '펼치자 바닥으로 끌려가 패널의 끝이 보인다');
  assert.ok(before !== null);
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
  await grow(); await sleep(350);                      // 여운(600ms) 안
  assert.ok(Math.abs((await seen('.trace-step')) - before) < 12, '읽던 표가 손 밑에서 달아났다');
  await sleep(1200);                                   // 여운이 지난 뒤
  assert.ok((await state()).rest < 8, '미룬 것을 영영 갚지 않아 답의 끝이 가려졌다');
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
  assert.strictEqual(pie.조각, 12);
  assert.ok(!pie.잘림, '원이 상자 밖으로 밀려 잘렸다');
  assert.strictEqual(pie.범례?.length, 12, '이름을 말할 범례가 없다');
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
  assert.ok(screen.글자 >= 9, `흐름도 글자가 ${screen.글자}px로 남았다`);
  await page.media('print');
  const paper = await page.eval(`(() => { const box = document.querySelector('.mermaid'); const svg = box.querySelector('svg');
    return { minWidth: getComputedStyle(svg).minWidth, 넘침: Math.round(svg.getBoundingClientRect().width - box.clientWidth) }; })()`);
  await page.media('screen');
  assert.strictEqual(paper.minWidth, '0px', '종이에서도 최소 폭이 걸려 오른쪽이 잘린다');
  assert.ok(paper.넘침 <= 1);
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
  assert.ok(box.입력창 <= 160, `입력창이 ${box.입력창}px까지 자랐다`);
  assert.ok(box.대화 > 60, '대화가 0px으로 눌렸다');
  assert.ok(box.단추가_화면안, '보내기 단추가 창 밖으로 나갔다');
});

it('모델이 쓴 주소는 저절로 불려 나가지 않는다 (그림·흐름도 라벨)', async () => {
  for (const c of ['images', 'mermaidhtml']) {
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
});

it('렌더링 중 콘솔에 예외가 오르지 않는다', async () => {
  assert.deepStrictEqual(page.logs, []);
});
