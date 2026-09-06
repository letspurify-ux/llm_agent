import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from './driver.mjs';
import { CASES, TRACE, READY } from './fixtures.js';

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
  const reply = { answer: CASES.rich, trace: TRACE };
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
  await page.until(READY.rich);
  assert.ok(await page.eval(`!!document.querySelector('.katex') && !document.querySelector('.typing')`));
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
  assert.deepEqual(page.logs, [], 'production 화면 콘솔에 오류가 남았다');
});
