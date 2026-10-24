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
    // 5초 상태 읽기를 시험 안에서 볼 수 있게 줄인다(__fastPoll을 켠 뒤 패널이 새로 설 때부터).
    const realSetInterval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...rest) => realSetInterval(fn, window.__fastPoll && ms === 5000 ? 50 : ms, ...rest);
    // __stallMcp: 상태 읽기가 답하지 않는다(끊으면 진짜 fetch처럼 AbortError). __release()가 걸린 것을 한꺼번에 답한다.
    window.__stalled = [];
    window.__release = () => { window.__stallMcp = false; window.__stalled.splice(0).forEach(f => f()); };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('/api/admin/')) return realFetch(url, opts);
      const path = new URL(url, location.origin).pathname.slice('/api/admin/'.length);
      const method = opts.method || 'GET';
      const body = opts.body && JSON.parse(opts.body);
      window.__requests.push({ path, method, ifMatch: opts.headers['If-Match'], body });
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (window.__requireToken && opts.headers['X-Admin-Token'] !== 'test-admin-key') return json({ error: '관리자 인증 키를 입력해주세요.' }, 401);
      if (path === 'mcp' && method === 'GET' && window.__stallMcp) return new Promise((resolve, reject) => {
        window.__stalled.push(() => resolve(json(window.__mcp)));
        opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      if (path === 'mcp' && method === 'GET') return window.__refreshFails ? json({ error: '서버에 연결하지 못했습니다.' }, 503) : json(window.__mcp);
      if (path === 'mcp-check' && window.__holdCheck) return new Promise(resolve => {
        window.__releaseCheck = () => { window.__holdCheck = false; resolve(window.fetch(url, opts)); };
      });
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

  // 상태를 거듭 읽어도 관리자 화면의 훅 대기열이 자라지 않는다. 읽기마다 인증 상태 셋을 같은 값으로 다시 넣는데,
  // 그 답은 MCP 패널만 다시 그리고 관리자 화면은 그리지 않아 렌더되지 않는 업데이트가 탭을 연 내내 쌓였다
  // (실측: 5초 읽기마다 3개, src/changed-state.js). 새로고침 단추가 그 읽기와 같은 길이다.
  const reads = await page.eval(`window.__requests.filter(r => r.path === 'mcp').length`);
  for (let i = 0; i < 20; i++) await clickText('.admin-mcp-caption button', '↻');
  await page.until(`window.__requests.filter(r => r.path === 'mcp').length >= ${reads + 20}`);
  await sleep(200);
  const queued = await page.eval(`(() => {
    const root = document.getElementById('root');
    const host = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))];
    const ring = u => { let n = 0; for (let x = u; x && n < 1e6; x = x.next) { n++; if (x.next === u) break; } return n; };
    let hooks = 0, worst = 0;
    const stack = host ? [host.stateNode?.current ?? host] : [];
    while (stack.length) {
      const f = stack.pop();
      for (let h = [0, 11, 15].includes(f.tag) ? f.memoizedState : null; h; h = h.next) {
        const q = h.queue;
        if (!q || typeof q !== 'object' || !('pending' in q)) continue;
        hooks++; worst = Math.max(worst, ring(q.pending) + ring(q.interleaved));
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return { hooks, worst };
  })()`);
  assert.ok(queued.hooks > 20, `검사의 전제: React 트리에서 상태 훅을 찾는다 (${JSON.stringify(queued)}) — React 내부 모양이 바뀌었으면 이 검사를 고칠 것`);
  assert.ok(queued.worst <= 2, `상태를 20번 읽은 뒤 한 훅의 대기열에 업데이트 ${queued.worst}개가 남았다`);

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

  // 상태 읽기가 답하지 않는 동안에는 다음 차례를 건너뛴다. 5초마다 새로 걸면 요청 한도(60초) 안에 열둘이 쌓여
  // 브라우저가 한 주소에 여는 연결 여섯을 다 차지했다 — 그 뒤로는 저장도, 다른 탭의 질문도 그 줄 뒤에 섰다.
  const statusReads = () => page.eval(`window.__requests.filter(r => r.path === 'mcp' && r.method === 'GET').length`);
  await page.eval('window.__fastPoll = true');
  await clickText('.admin-tabs button', '06');
  await page.until(`!!document.querySelector('.admin-mcp .admin-record')`);
  await sleep(200);
  assert.ok((await statusReads()) >= 3, '검사의 전제: 줄인 간격으로 상태를 거듭 읽는다');
  await page.eval('window.__stallMcp = true');
  await sleep(150);
  const stalledAt = await statusReads();
  await sleep(1000);
  assert.ok((await statusReads()) - stalledAt <= 1, `답하지 않는 상태 읽기 위에 ${(await statusReads()) - stalledAt}개를 더 걸었다`);
  // 걸린 읽기가 답하면 다시 차례대로 읽는다.
  await page.eval('window.__release()');
  const releasedAt = await statusReads();
  await page.until(`window.__requests.filter(r => r.path === 'mcp' && r.method === 'GET').length >= ${releasedAt + 3}`);

  // 폴더 선택 창은 상태 읽기가 패널을 다시 그려도 입력칸의 초점을 가져가지 않는다. 창이 여닫이(onClose)가 바뀔
  // 때마다 자기 자신에 초점을 주어, 경로를 치는 중에도 5초마다 초점이 입력칸에서 빠졌다.
  await page.eval('window.__mcp.editable = true');
  await page.until(`!document.querySelector('.admin-mcp-readonly')`);
  await click('.admin-mcp .admin-record');
  await page.until(`document.querySelector('#mcp-cwd') && !document.querySelector('.admin-editor fieldset').disabled`);
  await clickText('.admin-input-action button', '폴더 선택');
  await page.until(`!!document.querySelector('.admin-picker-path input')`);
  await page.eval(`document.querySelector('.admin-picker-path input').focus()`);
  const typingAt = await statusReads();
  await page.until(`window.__requests.filter(r => r.path === 'mcp' && r.method === 'GET').length >= ${typingAt + 3}`);
  assert.equal(await page.eval(`document.activeElement === document.querySelector('.admin-picker-path input')`), true, '상태를 다시 읽자 폴더 경로 칸의 초점이 빠졌다');
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.until(`!document.querySelector('.admin-picker-path')`);

  // 연결 확인(최대 30초)을 기다리는 사이 다른 서버를 열면, 늦게 온 확인 결과는 버린다. 그대로 받으면 새 편집기에
  // 앞 서버의 도구 목록과 '연결됨'이 서서, 그 도구를 골라 저장하면 이 서버의 허용 목록에 남의 도구 이름이 들어갔다.
  await page.eval('window.__holdCheck = true');
  await clickText('.admin-mcp-check button', '연결 확인');
  await page.until(`document.querySelector('.admin-mcp-check [role=status]')?.textContent.includes('연결하는 중')`);
  await clickText('.admin-mcp-caption button', '＋');
  await page.until(`document.querySelector('#mcp-name')?.value === ''`);
  assert.equal(await page.eval(`[...document.querySelectorAll('.admin-mcp-check button')].find(b => b.textContent === '연결 확인').disabled`), false,
    '새 편집기에서는 앞 편집기의 확인을 기다리지 않고 연결 확인을 누를 수 있다');
  await page.eval('window.__releaseCheck()');
  await sleep(300);
  const stale = await page.eval(`({ status: document.querySelector('.admin-mcp-check [role=status]')?.textContent ?? '',
    tools: [...document.querySelectorAll('.admin-mcp-tools label')].map(l => l.innerText) })`);
  assert.equal(stale.status, '', `앞 편집기의 연결 확인 결과가 새 편집기에 섰다: ${stale.status}`);
  assert.ok(!stale.tools.some(t => t.startsWith('search_pages')), `앞 편집기의 도구가 새 서버의 허용 목록 후보로 섰다: ${stale.tools}`);
  await clickText('.admin-form-actions button', '닫기');
  await page.eval('window.__fastPoll = false');
});
