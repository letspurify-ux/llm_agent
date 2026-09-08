import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from './driver.mjs';
import { CASES, TRACE } from './fixtures.js';
import { TABLE_FORMULAS, INCOMPLETE_TABLE_FORMULAS } from '../table-math-corpus.js';
import { checkLatex200 } from './latex-table-200-checks.mjs';
import { checkMixedContent } from './mixed-content-checks.mjs';
import { checkValidEdges } from './valid-edge-checks.mjs';
import { EDGE_CASES } from '../valid-math-edge-corpus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');

test('production 빌드에서도 대화·수식·차트·흐름도·조회 표가 동작한다', { timeout: 90_000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome이 필요합니다 (CHROME_PATH로 지정 가능)');
  // 오래된 dist가 초록불을 내지 않도록 현재 소스로 매번 빌드한다.
  await promisify(execFile)(process.execPath, [VITE, 'build'], { cwd: ROOT, timeout: 60_000 });
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'frontend-production-'));
  let server; let chrome; let page;
  killOnExit(() => [{ proc: chrome, group: true }, { proc: server }]);
  t.after(async () => {
    page?.ws.close();
    const browserStopped = await stopProcess(chrome, { group: true });
    const serverStopped = await stopProcess(server);
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    assert.ok(browserStopped && serverStopped, '검사가 띄운 프로세스가 남았다');
  });
  server = spawn(process.execPath, [VITE, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    assert.equal(server.exitCode, null, 'preview 서버가 종료됐다');
    try { ready = (await fetch(url)).ok; } catch {}
    if (!ready) await sleep(100);
  }
  assert.ok(ready, 'preview 서버를 시작하지 못했다');
  chrome = launchChrome({ bin, profile });
  page = await Page.open((await oneTab(await chromePort(profile))).webSocketDebuggerUrl);
  const reply = { answer: `${CASES.rich}\n\n${CASES.latex}\n\n${CASES.mixed}\n\n${CASES.tablemath}\n\n${CASES.latex200}`, trace: TRACE };
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const realFetch = window.fetch.bind(window);
    window.__requests = [];
    window.fetch = (url, opts) => {
      if (url !== '/api/chat') return realFetch(url, opts);
      window.__requests.push(JSON.parse(opts.body));
      return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(reply)}),
        { headers: { 'Content-Type': 'application/json' } }));
    };
  ` });
  await page.viewport(1000, 760);
  await page.goto(url, '.chip');
  await page.eval(`document.querySelector('.chip').click()`);
  await page.until(`[...document.querySelectorAll('figure.chart')].filter(f => f.querySelector('.recharts-surface')).length === 4 &&
    document.querySelector('.mermaid svg')`);
  assert.ok(await page.eval(`!!document.querySelector('.katex') && !document.querySelector('.typing')`));
  // mhchem의 명령 등록은 부수 효과이므로 실제 배포 번들에도 남아 있어야 한다.
  assert.ok(await page.eval(`document.querySelectorAll('.math-error').length === ${1 + INCOMPLETE_TABLE_FORMULAS.length} &&
    [...document.querySelectorAll('annotation')].some(e => e.textContent === ${JSON.stringify(String.raw`\ce{H2O}`)}) &&
    !document.querySelector('.bubble.assistant').innerText.includes('unsupportedExample')`));
  const tableFormulas = await page.eval(`[...document.querySelectorAll('td annotation')].map(e => e.textContent)`);
  assert.ok(TABLE_FORMULAS.every(tex => tableFormulas.includes(tex)), '배포 빌드에서 표의 절댓값 뒤가 잘렸다');
  await page.eval('document.fonts.ready.then(() => true)');
  await checkLatex200(page);
  await page.viewport(380, 760);
  await checkLatex200(page);
  await page.viewport(1000, 760);
  assert.ok(await page.eval(`![...document.querySelectorAll('.bubble.assistant .md > p')].some(e =>
    e.innerText.includes(${JSON.stringify(String.raw`\begin{`)}))`));
  await page.eval(`document.querySelector('.trace summary').click()`);
  await page.until(`document.querySelectorAll('.trace-grid tbody tr').length > 0`);
  if (process.env.UI_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.UI_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await page.eval(`document.querySelector('textarea').focus()`);
  await page.send('Input.insertText', { text: '계속 설명해줘' });
  await page.key('Enter', 'Enter', 13);
  await page.until(`document.querySelectorAll('.row.user').length === 2 && !document.querySelector('.typing')`);
  assert.equal(await page.eval(`window.__requests[1].history.length`), 2);
  await page.eval(`document.querySelector('.home-btn').click()`);
  await page.until(`document.querySelector('.empty') && !document.querySelector('.row')`);
  // 개발용 probe뿐 아니라 지연 로딩/최적화를 거친 배포 번들에서도 같은 중첩 조합을 확인한다.
  await page.eval(`window.fetch = async () => new Response(JSON.stringify({ answer: ${JSON.stringify(CASES.nestedmixed)} }),
    { headers: { 'Content-Type': 'application/json' } }); document.querySelector('.chip').click()`);
  await page.until(`document.querySelector('.mermaid svg') && document.querySelector('figure.chart .recharts-surface') && !document.querySelector('.typing')`);
  await page.eval(`document.querySelector('.chart-table').open = true`);
  for (const width of [1000, 380, 320]) {
    await page.viewport(width, 760);
    await checkMixedContent(page);
  }
  assert.deepEqual(page.logs, [], 'production 화면 콘솔에 오류가 남았다');
  await page.eval(`document.querySelector('.home-btn').click()`);
  await page.until(`document.querySelector('.chip')`);
  await page.eval(`window.fetch = async () => new Response(JSON.stringify({ answer: ${JSON.stringify(CASES.validedges)} }),
    { headers: { 'Content-Type': 'application/json' } }); document.querySelector('.chip').click()`);
  await page.until(`document.querySelectorAll('.bubble.assistant annotation').length === ${EDGE_CASES.length} && !document.querySelector('.typing')`);
  for (const width of [1000, 380, 320]) {
    await page.viewport(width, 760);
    await checkValidEdges(page);
  }
  assert.deepEqual(page.logs, [], 'production 정상 입력 경계 검사 콘솔에 오류가 남았다');
});

// 그림을 부르지 못하게 막는 정책(index.html의 CSP meta)은 브라우저가 그 줄을 읽은 '뒤에' 시작되는
// 요청부터 다스린다 — 자원을 부르는 요소(link·script·img)가 그 위에 오면 그것만 정책 밖에 선다.
// 그러고도 아무 오류가 나지 않는다. 원본에서는 charset 다음 자리에 두었지만 실제로 배포되는 것은
// vite가 스크립트와 스타일시트를 끼워 넣은 dist/index.html이고, 그 삽입 자리는 우리가 정하지 않는다.
// 그래서 원본이 아니라 빌드 결과에서 못 박는다 (원본 쪽 실수도 같이 걸린다).
// 주석은 먼저 걷어낸다 — 그 안에 설명으로 적힌 '<img>' 글자가 진짜 태그로 잡혀 검사가 거짓으로 깨진다.
test('production 빌드에서도 CSP가 자원을 부르는 어떤 태그보다 앞에 온다', { timeout: 90_000 }, async () => {
  const indexPath = join(ROOT, 'dist', 'index.html');
  // 앞 시험이 빌드해 두었더라도 여기서 다시 빌드한다. '있으면 그대로 읽는' 방식은 앞 시험이
  // 건너뛰거나(Chrome 없음) 이름으로 걸러졌을 때 낡은 dist를 검사하게 되고, 그러면 원본을
  // 고쳐 놓고도 통과한다 — 실측으로 그렇게 초록불이 났다. 검사가 무엇을 읽는지는 검사가 정해야 한다.
  await promisify(execFile)(process.execPath, [VITE, 'build'], { cwd: ROOT, timeout: 60_000 });
  const bare = (await readFile(indexPath, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const csp = bare.search(/<meta[^>]+http-equiv=["']?Content-Security-Policy/i);
  assert.ok(csp >= 0, 'dist/index.html에 CSP meta가 없다 — 모델이 쓴 주소가 그림으로 불려 나가는 마지막 그물이 사라졌다');
  assert.match(bare.slice(csp, csp + 200), /img-src/i, 'CSP가 img-src를 제한하지 않는다');
  const first = bare.search(/<(?:link|script|img|iframe|style)\b/i);
  assert.ok(first < 0 || csp < first,
    `자원을 부르는 태그가 CSP보다 앞에 있어 그 요청만 정책 밖에 선다: ${JSON.stringify(bare.slice(first, first + 90))}`);
});
