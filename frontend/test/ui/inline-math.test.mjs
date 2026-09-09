import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from './driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');
const LONG = String.raw`\frac{\text{ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ}}{\sqrt{x^2+y^2}}`;
const TALL = String.raw`\dfrac{\overbrace{\text{ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ}}^{n}}{\dfrac{1}{\sqrt{x^2+y^2}}}`;
const FORMULAS = ['x^2', LONG, LONG, LONG, LONG, TALL, `${LONG}+${LONG}`, 'a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t', LONG, LONG, LONG];
const ANSWER = [
  '짧은 수식 $x^2$ 뒤.',
  `문단 $${LONG}$ 끝.`,
  `> 1. **중첩 _수식 $${LONG}$_** 끝.`,
  `### 제목 $${LONG}$`,
  `[링크의 수식 $${LONG}$](https://example.test)`,
  `> > 높은 수식 $${TALL}$ 끝.`,
  `여러 덩어리 $${LONG}+${LONG}$ 끝.`,
  `$${FORMULAS[7]}$`,
  `| 표 | 수식 |\n|---|---|\n| 왼쪽 | $${LONG}$ |`,
  `별행\n\n$$\n${LONG}\n$$`,
  `각주[^math]\n\n[^math]: 수식 $${LONG}$`,
  '```chart\ntype: bar\n| 이름 | 값 |\n|---|---|\n| A | 7 |\n```',
  '```mermaid\nflowchart LR\nA["$$z^2$$"] --> B\n```',
].join('\n\n');

// 실제 앱의 API 응답을 바꾼다. 개발용 렌더러를 복제하지 않고 미리보기와
// 최종 답변을 같은 내용으로 비교하며, production에서도 같은 검사를 한다.
for (const production of [false, true]) test(`${production ? 'production' : 'dev'} 긴 인라인 수식: 중첩·스크롤·크기 변경·스트림·인쇄`, { timeout: 90_000 }, async t => {
  const bin = await findChrome({ required: true });
  if (production) await promisify(execFile)(process.execPath, [VITE, 'build'], { cwd: ROOT, timeout: 60_000 });
  const profile = await mkdtemp(join(tmpdir(), 'inline-math-'));
  let server, chrome, page;
  killOnExit(() => [{ proc: chrome, group: true }, { proc: server }]);
  t.after(async () => {
    page?.ws.close();
    const browserStopped = await stopProcess(chrome, { group: true });
    const serverStopped = await stopProcess(server);
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    assert.ok(browserStopped && serverStopped, '검사 프로세스 정리');
  });
  const port = await freePort();
  server = spawn(process.execPath, [VITE, ...(production ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    assert.equal(server.exitCode, null);
    try { ready = (await fetch(url)).ok; } catch {}
    if (!ready) await sleep(100);
  }
  assert.ok(ready);
  chrome = launchChrome({ bin, profile });
  page = await Page.open((await oneTab(await chromePort(profile))).webSocketDebuggerUrl);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__observed = new Map();
    const NativeObserver = ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback) { super(callback); window.__observed.set(this, new Set()); }
      observe(target, options) { window.__observed.get(this).add(target); super.observe(target, options); }
      unobserve(target) { window.__observed.get(this).delete(target); super.unobserve(target); }
      disconnect() { window.__observed.get(this).clear(); super.disconnect(); }
    };
  ` });
  await page.viewport(320, 900);
  await page.goto(url, '.chip');
  const observedBefore = await page.eval(`[...window.__observed.values()].reduce((n, s) => n + s.size, 0)`);
  await page.eval(`window.__answer = ${JSON.stringify(ANSWER)};
    window.fetch = async () => new Response(new ReadableStream({
      start(c) { window.__line = o => c.enqueue(new TextEncoder().encode(JSON.stringify(o) + '\\n')); window.__close = () => c.close(); }
    }), { headers: { 'Content-Type': 'application/x-ndjson' } }); document.querySelector('.chip').click()`);
  const first = ANSWER.indexOf('\n\n###');
  for (const [start, end] of [[0, first], [first, ANSWER.length]]) {
    await page.eval(`window.__line({type:'answer_delta',text:window.__answer.slice(${start},${end})})`);
    await page.until(`document.querySelectorAll('.preview .math-scroll').length >= ${start ? 6 : 2}`);
    await checkLayout(page, '.preview');
  }
  const preview = await page.eval(`[...document.querySelectorAll('.preview annotation')].map(e => e.textContent)`);
  assert.deepEqual(preview, FORMULAS);
  await page.eval(`window.__line({type:'done',answer:window.__answer}); window.__close()`);
  await page.until(`document.querySelector('.mermaid svg') && document.querySelector('figure.chart .recharts-surface') && !document.querySelector('.typing')`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.bubble.assistant .md annotation')].map(e => e.textContent)`), FORMULAS);
  assert.equal(await page.eval(`document.querySelectorAll('.mermaid math').length`), 1);
  for (const width of [320, 1000, 320]) {
    await page.viewport(width, 900);
    await page.eval('document.fonts.ready.then(() => true)');
    await page.until(`document.querySelectorAll('.math-scroll').length ${width === 320 ? '>= 6' : '< 6'}`);
    await checkLayout(page, '.bubble.assistant .md');
  }
  assert.equal(await page.eval(`document.querySelector('td .katex').classList.contains('math-scroll')`), false, '표는 바깥의 스크롤을 사용한다');
  assert.equal(await page.eval(`document.querySelector('.katex-display .katex').classList.contains('math-scroll')`), false);
  assert.deepEqual(await page.eval(`(()=>{const a=document.querySelector('a[href="https://example.test"]'); return [a.target,a.querySelectorAll('[tabindex]').length,a.querySelectorAll('a').length]})()`), ['_blank', 0, 0]);
  await page.eval(`window.__math = document.querySelector('.math-scroll:not(a .math-scroll)'); window.__math.scrollLeft = 0; window.__math.focus()`);
  await page.key('ArrowRight', 'ArrowRight', 39);
  await page.until('window.__math.scrollLeft > 0');
  if (process.env.INLINE_MATH_SCREENSHOT) {
    await page.eval(`document.querySelector('.bubble.assistant').scrollIntoView({block:'start'})`);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.INLINE_MATH_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  await page.eval(`window.dispatchEvent(new Event('beforeprint'))`);
  await page.until(`getComputedStyle(document.querySelector('.math-scroll')).overflowX === 'visible'`);
  const print = await page.eval(`(()=>{const bad=[]; for(const e of document.querySelectorAll('.math-scroll')) {
    let block=e.parentElement; while(['inline','contents'].includes(getComputedStyle(block).display)) block=block.parentElement;
    const r=e.getBoundingClientRect(), b=block.getBoundingClientRect();
    if(r.right>b.right+2 || r.left<b.left-2) bad.push({tex:e.querySelector('annotation').textContent,width:r.width,block:b.width,right:r.right,limit:b.right});
  } return bad;})()`);
  assert.deepEqual(print, [], '인쇄 시 수식 전체가 컨테이너 안에 들어와야 한다');
  await page.send('Page.printToPDF', { printBackground: true });
  await page.send('Emulation.setEmulatedMedia', { media: 'screen' });
  await page.eval(`window.dispatchEvent(new Event('afterprint'))`);
  await checkLayout(page, '.bubble.assistant .md');
  await page.eval(`document.querySelector('.home-btn').click()`);
  await page.until(`document.querySelector('.empty') && !document.querySelector('.row')`);
  assert.equal(await page.eval(`[...window.__observed.values()].reduce((n,s)=>n+s.size,0)`), observedBefore, '대화 초기화 후 수식 관찰 대상이 남았다');
  assert.deepEqual(page.logs, [], '수식 배치 및 정리 중 콘솔 오류');
});

async function checkLayout(page, root) {
  const result = await page.eval(`(()=>{
    const root=document.querySelector(${JSON.stringify(root)}), failures=[];
    const short=[...root.querySelectorAll('.katex')].find(e=>e.querySelector('annotation')?.textContent==='x^2');
    if(short.classList.contains('math-scroll') || short.getBoundingClientRect().height>23 || short.parentElement.getBoundingClientRect().height>25) failures.push('짧은 수식의 기준선/줄 높이 변경');
    for(const e of root.querySelectorAll('.math-scroll')) {
      const r=e.getBoundingClientRect(), content=e.querySelector('.katex-html');
      if(e.clientWidth<=0 || e.scrollWidth<=e.clientWidth || getComputedStyle(e).overflowX!=='auto') failures.push('스크롤 영역 없음');
      e.scrollLeft=e.scrollWidth;
      const c=content.getBoundingClientRect();
      if(c.right>r.right+2 || e.scrollLeft<=0) failures.push('수식 끝에 도달 불가');
      for(const base of content.querySelectorAll(':scope > .base')) {
        const b=base.getBoundingClientRect();
        if(b.top<r.top-1 || b.bottom>r.bottom+1) failures.push('수식 위아래 잘림');
      }
      e.scrollLeft=0;
      if(content.getBoundingClientRect().left<r.left-1) failures.push('수식 시작에 도달 불가');
      if(!e.closest('a') && (e.tabIndex!==0 || !e.getAttribute('aria-label'))) failures.push('키보드 접근 불가');
    }
    if(document.documentElement.scrollWidth>innerWidth+1) failures.push('화면 가로 넘침');
    if(root.querySelector('.math-error,.preview-raw')) failures.push('정상 수식 렌더링 실패');
    return failures;
  })()`);
  assert.deepEqual(result, [], `인라인 배치 ${root}`);
}
