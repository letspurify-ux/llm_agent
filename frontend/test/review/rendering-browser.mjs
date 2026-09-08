// 검토용 실제 앱 검사. --production은 현재 소스를 새로 빌드해 검사한다.
// 실행: node frontend/test/review/rendering-browser.mjs --production
// 결과 JSON은 stdout, 실패 재현 시 종료 코드 1. 실제 DB/LLM 접속은 없다.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from '../ui/driver.mjs';
import { resolveChartData, resolveTableData } from '../../../backend/src/chart.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');
const production = process.argv.includes('--production');
const cases = [
  { id: 'normal-mixed', answer: '본문 $x=1$\n\n```chart\ntype: bar\n| A | B |\n|---|---|\n| a | 1 |\n```\n\n```mermaid\nflowchart LR\n A --> B\n```',
    expected: { charts: 1, diagrams: 1, formulas: ['x=1'], errors: 0 } },
  { id: 'unclosed-math-cross-blocks', answer: '\\[x=1\n\n```chart\ntype: bar\n| A | B |\n|---|---|\n| a | 1 |\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n\\[y=2\\]\n\nEND',
    expected: { charts: 1, diagrams: 1, formulas: ['y=2'] } },
  { id: 'quoted-chart-data', answer: resolveChartData('본문 $x=1$\n\n> ```chart\n> type: bar\n> data: step 1\n> ```\n\nEND', [[{ A: 'FOUND_ROW', B: 1 }]]),
    expected: { charts: 1, formulas: ['x=1'] } },
  { id: 'quoted-table-data', answer: resolveTableData('본문 $x=1$\n\n> ```table\n> step: 1\n> ```\n\nEND', [[{ A: 'FOUND_ROW', B: 1 }]]),
    expected: { tables: 1, foundRow: true, formulas: ['x=1'] } },
  { id: 'table-cell-chart-data', answer: resolveChartData('| 항목 | 상세 |\n|---|---|\n| 조회 | `chart<br>type: bar<br>data: step 1` |',
    [[{ A: 'FOUND_ROW | 원문', B: 1 }, { A: '다음 값', B: 2 }]]),
    expected: { charts: 1, tables: 2, foundRow: true } },
  { id: 'standalone-chart-data', answer: resolveChartData('`chart\\ntype: bar\\ndata: step 1`', [[{ A: 'FOUND_ROW', B: 1 }]]),
    expected: { charts: 1, foundRow: true } },
  { id: 'flowchart-math', answer: '본문 $x^2$\n\n```mermaid\nflowchart LR\n A["$$x^2$$"] --> B[완료]\n```',
    expected: { diagrams: 1, mermaidMath: 1, formulas: ['x^2'] } },
  { id: 'sequence-math-control', answer: '```mermaid\nsequenceDiagram\n A->>B: $$\\frac{1}{2}$$\n```',
    expected: { diagrams: 1, mermaidMath: 1 } },
  { id: 'footnote-math-id', answer: '본문 [^$x$]와 $y$.\n\n[^$x$]: FOOTNOTE_CONTENT',
    expected: { footnotes: 1, footnoteContent: true, formulas: ['y'] } },
  { id: 'adjacent-inline-dollars', answer: '$x$$y$', expected: { formulas: ['x', 'y'] } },
];

if (production) await promisify(execFile)(process.execPath, [VITE, 'build'], { cwd: ROOT, timeout: 60_000 });
const port = await freePort();
const profile = await mkdtemp(join(tmpdir(), 'render-review-chrome-'));
let chrome, page;
const vite = spawn(process.execPath, [VITE, ...(production ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
killOnExit(() => [{ proc: chrome, group: true }, { proc: vite }]);
try {
  const url = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(vite.exitCode, null, 'Vite가 종료됐다');
    try { ready = (await fetch(url)).ok; } catch {}
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready, 'Vite 시작 실패');
  chrome = launchChrome({ bin: await findChrome({ required: true }), profile });
  page = await Page.open((await oneTab(await chromePort(profile))).webSocketDebuggerUrl);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => url === '/api/chat'
      ? Promise.resolve(new Response(JSON.stringify({ answer: window.__reviewAnswer }), { headers: { 'Content-Type': 'application/json' } }))
      : originalFetch(url, opts);
  ` });
  const results = [];
  for (const { id, answer, expected } of cases) for (const width of [1000, 320]) {
    await page.viewport(width, 760);
    await page.goto(url, '.chip');
    await page.eval(`window.__reviewAnswer=${JSON.stringify(answer)};document.querySelector('.chip').click()`);
    await page.until(`document.querySelector('.bubble.assistant') && !document.querySelector('.typing')`);
    // 깨진 조합의 결함 판정을 시간제한 오류에 의존하지 않는다. 존재해야 하는 요소를
    // 기다리는 대신 실제 남은 폴백/원문/그림 중 하나가 확정됐는지 기다린다.
    if (answer.includes('```mermaid')) await page.until(`document.querySelector('.mermaid svg') || document.querySelector('.math-error')`);
    // production의 지연 로딩 동안에는 데이터 표만 먼저 표시된다.
    if (expected.charts) await page.until(`document.querySelector('figure.chart .recharts-surface')`);
    await page.eval('document.fonts.ready.then(() => true)');
    const actual = await page.eval(`(() => {
      const b = document.querySelector('.bubble.assistant');
      return {
        text: b.innerText,
        charts: b.querySelectorAll('figure.chart .recharts-surface').length,
        diagrams: b.querySelectorAll('.mermaid svg').length,
        tables: b.querySelectorAll('table').length,
        errors: b.querySelectorAll('.math-error').length,
        formulas: [...b.querySelectorAll('annotation')].map(e => e.textContent),
        mermaidMath: b.querySelectorAll('.mermaid math').length,
        footnotes: b.querySelectorAll('[data-footnote-ref]').length,
        footnoteContent: b.textContent.includes('FOOTNOTE_CONTENT'),
        foundRow: b.textContent.includes('FOUND_ROW'),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    const failures = [];
    for (const [key, value] of Object.entries(expected)) {
      try { assert.deepEqual(actual[key], value); }
      catch { failures.push({ key, expected: value, actual: actual[key] }); }
    }
    if (actual.overflow > 1) failures.push({ key: 'overflow', actual: actual.overflow });
    const logs = page.logs.splice(0);
    if (logs.length) failures.push({ key: 'console', actual: logs });
    results.push({ id, width, pass: !failures.length, failures, actual });
  }
  console.log(JSON.stringify({ mode: production ? 'production' : 'development', pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length, results }, null, 2));
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
} finally {
  page?.ws.close();
  const browserStopped = await stopProcess(chrome, { group: true });
  const serverStopped = await stopProcess(vite);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  assert.ok(browserStopped && serverStopped, '검사가 띄운 프로세스가 남았다');
}
