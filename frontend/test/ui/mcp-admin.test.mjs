import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from './driver.mjs';

// MCP 탭: 목록·상태·편집·비밀값·연결 확인·보기 전용. /api/admin/mcp*는 가짜 fetch가 답한다.
test('MCP 탭 서버 목록·상태·허용 도구 저장·비밀값 지우기·연결 확인·보기 전용', { timeout: 90_000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome이 필요합니다');
  const root = new URL('../../', import.meta.url);
  const profile = await mkdtemp(join(tmpdir(), 'mcp-admin-ui-'));
  const port = await freePort();
  let server, chrome, page;
  killOnExit(() => [{ proc: chrome, group: true }, { proc: server }]);
  t.after(async () => {
    page?.ws.close();
    const stopped = await Promise.all([stopProcess(chrome, { group: true }), stopProcess(server)]);
    await rm(profile, { recursive: true, force: true });
    assert.ok(stopped.every(Boolean));
  });
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(url)).ok; } catch {}
    if (!ready) await sleep(100);
  }
  assert.ok(ready);
  chrome = launchChrome({ bin, profile });
  page = await Page.open((await oneTab(await chromePort(profile))).webSocketDebuggerUrl);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const tool = (name, allowed, extra = {}) => ({ name, exposed: 'jira__' + name, description: name + ' 설명', annotations: null, allowed, tokens: 40,
      calls: 0, failures: 0, cancelled: 0, avg_ms: null, last_ms: null, last_error: null, last_at: null, ...extra });
    window.__mcp = { editable: true, default_timeout_secs: 30, servers: [{
      name: 'jira', description: '사내 Jira', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'], cwd: '', url: '',
      tools: ['search'], timeout_secs: null, env: { JIRA_URL: 'https://jira' }, headers: {}, secrets: { env: ['JIRA_TOKEN'], headers: [] },
      revision: '1'.repeat(64),
      status: { name: 'jira', enabled: true, transport: 'stdio', state: 'ready', since: '2026-10-17T01:00:00Z', error: null, restarts: 2, retry_at: null, pid: 42,
        server_info: { name: 'jira-mcp', version: '0.9.0', protocol_version: '2025-06-18', instructions: '검색 먼저 하세요' },
        tools: [tool('search', true, { annotations: { readOnlyHint: true }, calls: 3, failures: 1, avg_ms: 120, last_error: 'mcp_timeout: 느림', refused: { model: 'gpt-4o', reason: 'http_400: Invalid schema for function', at: '2026-10-17T01:00:00Z' } }), tool('delete_issue', false, { annotations: { destructiveHint: true } })],
        log: [{ at: '2026-10-17T01:00:00Z', source: 'event', text: '연결됨: jira-mcp 0.9.0' }] },
    }] };
    window.__requests = [];
    window.confirm = () => true;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('/api/admin/')) return realFetch(url, opts);
      const path = new URL(url, location.origin).pathname.slice('/api/admin/'.length);
      const method = opts.method || 'GET';
      const body = opts.body && JSON.parse(opts.body);
      window.__requests.push({ path, method, ifMatch: opts.headers['If-Match'], body });
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (window.__requireToken && opts.headers['X-Admin-Token'] !== 'test-admin-key') return json({ error: '관리자 인증 키를 입력해주세요.' }, 401);
      if (path === 'mcp' && method === 'GET') return window.__refreshFails ? json({ error: '서버에 연결하지 못했습니다.' }, 503) : json(window.__mcp);
      if (path === 'mcp-check') return json({ ok: true, message: '연결됨: wiki-mcp 1.0, 도구 2개', tools: [
        { name: 'search_pages', exposed: 'wiki__search_pages', description: '페이지 검색', annotations: { readOnlyHint: true }, allowed: false, tokens: 55 },
        { name: 'edit_page', exposed: 'wiki__edit_page', description: '페이지 편집', annotations: null, allowed: false, tokens: 70 }], log: [] });
      if (path === 'mcp' && method === 'POST') {
        const saved = { ...body, transport: body.url ? 'http' : 'stdio', secrets: { env: [], headers: [] }, revision: '2'.repeat(64), status: null };
        window.__mcp.servers.push(saved);
        return json(saved, 201);
      }
      if (path.startsWith('mcp/') && method === 'PUT') {
        const current = window.__mcp.servers[0];
        if (opts.headers['If-Match'] !== '"' + current.revision + '"') return json({ error: '다른 화면에서 변경되었습니다.' }, 409);
        const secrets = { env: current.secrets.env.filter(name => body.secrets?.env?.[name] !== null), headers: [] };
        Object.assign(current, body, { secrets, revision: '3'.repeat(64) });
        return json(current);
      }
      return json({ error: '없는 요청' }, 404);
    };
  ` });
  const click = selector => page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (selector, text) => page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim().startsWith(${JSON.stringify(text)})).click()`);
  const fill = (selector, value) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const last = () => page.eval(`window.__requests.filter(r => r.method !== 'GET').at(-1)`);
  await page.viewport(1280, 900);
  await page.goto(url, '.chip');
  await click('.admin-nav-button');
  await page.until(`!!document.querySelector('.admin-tabs')`);
  await clickText('.admin-tabs button', '06');
  await page.until(`!!document.querySelector('.admin-mcp .admin-record')`);
  const card = await page.eval(`document.querySelector('.admin-mcp .admin-record').innerText`);
  for (const part of ['준비됨', 'jira', '도구 1/2 허용', '호출 3회', '실패 1회', '모델이 받지 않은 도구 1개']) assert.ok(card.includes(part), `${part} in ${card}`);

  // 열면 상태·호출 현황·기록이 보이고, 허용 도구를 바꿔 저장하면 If-Match와 바뀐 목록이 간다.
  await click('.admin-mcp .admin-record');
  await page.until(`!!document.querySelector('.admin-mcp-status table')`);
  const status = await page.eval(`document.querySelector('.admin-mcp-status').innerText`);
  for (const part of ['재연결', '2회', 'jira-mcp 0.9.0', '120 ms', 'mcp_timeout: 느림', '연결됨: jira-mcp 0.9.0', '✓ 빠짐']) assert.ok(status.includes(part), `${part} in status`);
  const hints = await page.eval(`document.querySelector('.admin-mcp-tools').innerText`);
  assert.ok(hints.includes('읽기 전용') && hints.includes('변경·삭제 가능') && hints.includes('모델 gpt-4o이(가) 정의를 받지 않아 빠짐'), hints);
  assert.equal(await page.eval(`document.querySelector('.admin-form-actions [type=submit]').disabled`), true, '바뀐 것이 없으면 저장하지 않는다');
  await page.eval(`[...document.querySelectorAll('.admin-mcp-tools label')].find(l => l.innerText.startsWith('delete_issue')).querySelector('input').click()`);
  await clickText('.admin-mcp-secrets button', '지우기');
  await page.until(`document.querySelector('.admin-mcp-secrets').innerText.includes('지울 예정')`);
  await click('.admin-form-actions [type=submit]');
  await page.until(`document.querySelector('.admin-success')?.textContent.includes('저장했습니다')`);
  let saved = await last();
  assert.equal(saved.method, 'PUT');
  assert.equal(saved.path, 'mcp/jira');
  assert.equal(saved.ifMatch, `"${'1'.repeat(64)}"`);
  assert.deepEqual(saved.body.tools, ['search', 'delete_issue']);
  assert.deepEqual(saved.body.secrets, { env: { JIRA_TOKEN: null } });
  assert.deepEqual(saved.body.args, ['-y', 'jira-mcp']);
  assert.deepEqual(saved.body.env, { JIRA_URL: 'https://jira' });
  assert.equal(await page.eval(`document.querySelector('.admin-mcp-secrets').innerText.includes('JIRA_TOKEN')`), false);

  // 상태 새로고침이 실패하면 따로 알리고, 다시 되면 지운다(저장 오류와 섞이지 않는다).
  await page.eval('window.__refreshFails = true');
  await clickText('.admin-mcp-caption button', '↻');
  await page.until(`document.querySelector('.admin-mcp .admin-feedback')?.innerText.includes('상태를 새로 읽지 못했습니다')`);
  assert.equal(await page.eval(`!!document.querySelector('.admin-mcp .admin-error')`), false);
  await page.eval('window.__refreshFails = false');
  await clickText('.admin-mcp-caption button', '↻');
  await page.until(`!document.querySelector('.admin-mcp .admin-feedback')?.innerText.includes('상태를 새로 읽지 못했습니다')`);

  // 새 서버: 연결 확인으로 받은 도구를 골라 저장한다.
  await clickText('.admin-mcp-caption button', '＋');
  await page.until(`document.querySelector('#mcp-name')?.value === ''`);
  await clickText('.admin-mcp-choice label', 'HTTP');
  await fill('#mcp-name', 'wiki');
  await fill('#mcp-url', 'http://wiki/mcp');
  await fill('.admin-mcp-secrets input[aria-label="비밀값 이름"]', 'Authorization');
  await fill('.admin-mcp-secrets input[aria-label="비밀값"]', 'Bearer x');
  await clickText('.admin-mcp-secrets button', '넣기');
  await clickText('.admin-mcp-check button', '연결 확인');
  await page.until(`document.querySelector('.admin-check-ok')?.textContent.includes('wiki-mcp')`);
  const check = await last();
  assert.equal(check.path, 'mcp-check');
  assert.equal(check.body.url, 'http://wiki/mcp');
  assert.equal(check.body.original, undefined);
  await page.until(`[...document.querySelectorAll('.admin-mcp-tools label')].some(l => l.innerText.startsWith('search_pages'))`);
  await page.eval(`[...document.querySelectorAll('.admin-mcp-tools label')].find(l => l.innerText.startsWith('search_pages')).querySelector('input').click()`);
  assert.ok((await page.eval(`document.querySelector('.admin-mcp-tools').parentElement.innerText`)).includes('약 55 토큰'));
  await click('.admin-form-actions [type=submit]');
  await page.until(`document.querySelector('.admin-success')?.textContent.includes('저장했습니다')`);
  saved = await last();
  assert.equal(saved.method, 'POST');
  assert.deepEqual(saved.body.tools, ['search_pages']);
  assert.deepEqual(saved.body.secrets, { headers: { Authorization: 'Bearer x' } });
  assert.equal(saved.body.command, '');

  await page.viewport(320, 760);
  assert.ok(await page.eval(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.admin').scrollWidth <= innerWidth`), 'MCP 편집기도 작은 화면에서 넘치지 않는다');
  await page.viewport(1280, 900);

  // 관리자 인증 키가 없는 서버: 보기만 된다.
  await page.eval(`window.__mcp.editable = false`);
  await clickText('.admin-form-actions button', '닫기');
  await clickText('.admin-tabs button', '07');
  await clickText('.admin-tabs button', '06');
  await page.until(`!!document.querySelector('.admin-mcp-readonly')`);
  assert.equal(await page.eval(`[...document.querySelectorAll('.admin-mcp-caption button')].find(b => b.textContent.includes('서버 추가')).disabled`), true);
  await click('.admin-mcp .admin-record');
  await page.until(`!!document.querySelector('.admin-editor fieldset')`);
  assert.equal(await page.eval(`document.querySelector('.admin-editor fieldset').disabled`), true);
  assert.equal(await page.eval(`[...document.querySelectorAll('.admin-form-actions button')].some(b => b.textContent === '삭제')`), false);

  // 키가 바뀐 서버: MCP 탭 위에 뜬 인증 화면도 맞는 키를 넣으면 넘어간다. 인증 화면 밑의 패널은
  // 내려가 있어 키를 실어 보낼 요청이 따로 있어야 한다(없을 때는 오류도 없이 그대로 멈췄다).
  await clickText('.admin-form-actions button', '닫기');
  await page.eval('window.__requireToken = true');
  await clickText('.admin-mcp-caption button', '↻');
  await page.until(`!!document.querySelector('#admin-token')`);
  await fill('#admin-token', 'wrong-key'); await click('.admin-auth [type=submit]');
  await page.until(`document.querySelector('.admin-auth .admin-error')?.textContent.includes('인증에 실패했습니다')`);
  await fill('#admin-token', 'test-admin-key'); await click('.admin-auth [type=submit]');
  await page.until(`!document.querySelector('.admin-auth') && !!document.querySelector('.admin-mcp .admin-record')`);

  // 인증 화면에서 설정 탭으로 옮긴 뒤 넣어도 마찬가지다.
  await click('[aria-label="채팅으로 돌아가기"]'); await click('[aria-label="관리자 화면 열기"]');
  await page.until(`!!document.querySelector('#admin-token')`);
  await clickText('.admin-tabs button', '07');
  await fill('#admin-token', 'test-admin-key'); await click('.admin-auth [type=submit]');
  await page.until(`!document.querySelector('.admin-auth') && document.querySelector('.admin-section-heading h3')?.textContent === '서버 설정'`);
  assert.ok((await page.eval(`window.__requests.filter(r => r.path === 'settings').length`)) >= 1, '설정 탭의 인증도 요청으로 확인한다');
});
