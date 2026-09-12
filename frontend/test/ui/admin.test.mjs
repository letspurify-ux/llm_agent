import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from './driver.mjs';

for (const production of [false, true]) {
test(`${production ? 'production' : 'dev'} 관리 화면 검색·페이지 이동·저장·오류 복구·대화 유지·작은 화면`, { timeout: 90_000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome이 필요합니다');
  const root = new URL('../../', import.meta.url);
  if (production) await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: root, timeout: 60_000 });
  const profile = await mkdtemp(join(tmpdir(), 'admin-ui-'));
  const port = await freePort();
  let server, chrome, page;
  killOnExit(() => [{ proc: chrome, group: true }, { proc: server }]);
  t.after(async () => {
    page?.ws.close();
    const stopped = await Promise.all([stopProcess(chrome, { group: true }), stopProcess(server)]);
    await rm(profile, { recursive: true, force: true });
    assert.ok(stopped.every(Boolean));
  });
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(production ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
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
    window.__records = {
      databases: [{ seq: 1, db_name: 'ORDER_DB', db_type: 'oracle', connection_info: 'localhost:1521/FREEPDB1', db_user: 'reader', has_password: true }],
      knowledge: Array.from({ length: 43 }, (_, i) => ({ seq: i + 1, title: '업무 지식 ' + (i + 1), content: i === 5 ? '본문으로만 찾을 수 있는 고객 식별자' : 'SPACE 운영 안내 문서입니다.' })),
      methods: [], queries: [],
    };
    window.__requests = []; window.__reject = false; window.__confirm = true;
    window.__revision = 1000;
    for (const rows of Object.values(window.__records)) for (const row of rows) row.revision = String(++window.__revision).padStart(64, '0');
    window.confirm = () => window.__confirm;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts = {}) => {
      if (url === '/api/chat' && window.__chatReply) return new Response(JSON.stringify({ answer: window.__chatReply, trace: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (!String(url).startsWith('/api/admin/')) return realFetch(url, opts);
      const parsed = new URL(url, location.origin);
      const [kind, id] = parsed.pathname.slice('/api/admin/'.length).split('/');
      const method = opts.method || 'GET';
      window.__requests.push({ url, method, ifMatch: opts.headers['If-Match'], body: opts.body && JSON.parse(opts.body) });
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (window.__requireToken && opts.headers['X-Admin-Token'] !== 'test-admin-key') return json({ error: '관리자 인증 키를 입력해주세요.' }, 401);
      if (kind === 'database-options') return json({ items: window.__records.databases });
      const rows = window.__records[kind];
      if (method === 'GET') {
        if (id) return json(rows.find(row => row.seq === Number(id)));
        const q = parsed.searchParams.get('q').toLowerCase();
        const matches = rows.filter(row => Object.values(row).join(' ').toLowerCase().includes(q)).slice().reverse();
        const page = Math.min(Number(parsed.searchParams.get('page')), Math.max(1, Math.ceil(matches.length / 20)));
        return json({ items: matches.slice((page - 1) * 20, page * 20).map(row => ({ seq: row.seq, query_type: row.query_type, name: row.title || row.db_name || row.query_name, summary: row.content || row.method || row.query_desc || row.connection_info })), total: matches.length, page, pageSize: 20 });
      }
      if (window.__reject) return json({ error: '같은 이름의 항목이 이미 있습니다.' }, 409);
      if (id && opts.headers['If-Match'] !== '"' + rows.find(row => row.seq === Number(id)).revision + '"') return json({ error: '다른 화면에서 변경되었습니다.' }, 409);
      if (method === 'DELETE') { window.__records[kind] = rows.filter(row => row.seq !== Number(id)); return new Response(null, { status: 204 }); }
      const body = JSON.parse(opts.body);
      const row = { ...body, seq: id ? Number(id) : Math.max(0, ...rows.map(row => row.seq)) + 1, revision: String(++window.__revision).padStart(64, '0') };
      if (kind === 'databases') { delete row.db_password; row.has_password = true; }
      if (id) rows.splice(rows.findIndex(item => item.seq === Number(id)), 1, row); else rows.push(row);
      return json(row, method === 'POST' ? 201 : 200);
    };
  ` });
  const click = selector => page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const tab = n => click(`.admin-tabs button:nth-child(${n})`);
  const loaded = () => page.until(`document.querySelector('.admin-records')?.getAttribute('aria-busy') === 'false'`);
  await page.viewport(1280, 900);
  await page.goto(url, '.chip');
  const chatDraft = '작성 중인 질문\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄';
  await fill('.composer textarea', chatDraft);
  await click('[aria-label="관리자 화면 열기"]'); await loaded();
  await click('.admin-record'); await page.until(`document.querySelector('#admin-field-db_name')`);
  assert.equal(await page.eval(`document.querySelector('#admin-field-db_password').value`), '');
  await fill('#admin-field-db_user', 'updated_reader');
  await click('.admin-form-actions [type=submit]'); await page.until(`document.querySelector('.admin-success')`);
  assert.equal(await page.eval(`window.__requests.find(r => r.method === 'PUT').body.db_password`), '');
  await tab(2); await loaded();
  assert.equal(await page.eval(`document.querySelectorAll('.admin-record').length`), 20);
  await click('[aria-label="다음 페이지"]'); await loaded();
  assert.match(await page.eval(`document.querySelector('.admin-pagination').innerText`), /21–40/);
  await fill('[aria-label="지식 검색"]', '고객 식별자'); await loaded();
  assert.equal(await page.eval(`document.querySelectorAll('.admin-record').length`), 1);
  assert.match(await page.eval(`document.querySelector('.admin-record').innerText`), /업무 지식 6/);
  await fill('[aria-label="지식 검색"]', '없는 검색어'); await loaded();
  assert.match(await page.eval(`document.querySelector('.admin-empty').innerText`), /검색 결과가 없습니다/);
  await tab(3); await loaded();
  await click('.admin-section-heading .admin-primary');
  await fill('#admin-field-title', '고객 주문 확인'); await fill('#admin-field-method', 'CUSTOMER_ORDERS 쿼리로 주문을 조회합니다.');
  await page.eval('window.__confirm = false'); await tab(1);
  assert.equal(await page.eval(`document.querySelector('#admin-field-title').value`), '고객 주문 확인');
  await page.eval('window.__reject = true'); await click('.admin-form-actions [type=submit]');
  await page.until(`document.querySelector('.admin-error')`);
  assert.equal(await page.eval(`document.querySelector('#admin-field-method').value`), 'CUSTOMER_ORDERS 쿼리로 주문을 조회합니다.');
  await page.eval('window.__reject = false'); await click('.admin-form-actions [type=submit]');
  await page.until(`document.querySelector('.admin-success')`); await loaded();
  assert.equal(await page.eval(`window.__records.methods.length`), 1);
  await tab(4); await loaded(); await click('.admin-section-heading .admin-primary');
  await fill('#admin-field-query_name', 'CUSTOMER_ORDERS'); await fill('#admin-field-query_desc', '고객별 주문 상태 조회');
  await fill('#admin-field-query_sql', 'SELECT * FROM orders WHERE customer_id = :customer_id');
  await page.until(`document.querySelector('.admin-db-options input')`);
  await page.eval(`document.querySelector('.admin').scrollTop = document.querySelector('.admin').scrollHeight`);
  const writesBeforeMissingTargetDb = await page.eval(`window.__requests.filter(r => r.method === 'POST' && r.url.endsWith('/queries')).length`);
  await click('.admin-form-actions [type=submit]');
  await page.until(`document.querySelector('#admin-field-target_db_name-error')?.textContent.includes('대상 DB')`);
  assert.equal(await page.eval(`window.__requests.filter(r => r.method === 'POST' && r.url.endsWith('/queries')).length`), writesBeforeMissingTargetDb, '대상 DB가 없으면 저장 요청을 보내지 않는다');
  assert.equal(await page.eval(`document.querySelector('.admin-db-picker').getAttribute('aria-invalid')`), 'true');
  await page.until(`(() => { const r = document.querySelector('#admin-field-target_db_name-error').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })()`); // smooth 스크롤 완료를 기다린다.
  await click('.admin-db-options input');
  await click('.admin-form-actions [type=submit]'); await page.until(`document.querySelector('.admin-success')`);
  assert.equal(await page.eval(`window.__records.queries[0].target_db_name`), 'ORDER_DB');
  // 대상 DB 검색창의 Enter가 아직 저장하지 않은 다른 변경까지 제출해서는 안 된다.
  await fill('#admin-field-query_desc', '아직 저장하지 않은 설명');
  await fill('[aria-label="대상 DB 목록 검색"]', 'ORDER');
  await page.eval(`document.querySelector('[aria-label="대상 DB 목록 검색"]').focus()`);
  const writesBeforeSearch = await page.eval(`window.__requests.filter(r => r.method === 'PUT').length`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(150);
  assert.equal(await page.eval(`window.__requests.filter(r => r.method === 'PUT').length`), writesBeforeSearch, 'DB 검색 Enter는 저장 동작이 아니다');
  await click('.admin-form-actions [type=submit]'); await page.until(`document.querySelector('.admin-success')`);
  // 이미 열어 둔 편집기와 다른 화면/SQL에서 변경된 내용이 충돌하면 초안을 남기고 덮어쓰지 않는다.
  await page.eval(`Object.assign(window.__records.queries[0], { query_desc: '다른 관리자 변경', target_db_name: 'OLD_DB', revision: String(++window.__revision).padStart(64, '0') })`);
  await fill('#admin-field-output_desc', '보존해야 할 초안'); await click('.admin-form-actions [type=submit]');
  await page.until(`document.querySelector('.admin-error')?.textContent.includes('다른 화면')`);
  assert.equal(await page.eval(`document.querySelector('#admin-field-output_desc').value`), '보존해야 할 초안');
  assert.equal(await page.eval(`window.__records.queries[0].query_desc`), '다른 관리자 변경');
  await page.eval('window.__confirm = true'); await click('.admin-record');
  await page.until(`document.querySelector('#admin-field-query_desc').value === '다른 관리자 변경'`);
  assert.ok(await page.eval(`!!document.querySelector('[aria-label="OLD_DB 선택 해제"]')`), '목록에 없는 이전 대상 DB도 선택 해제할 수 있다');
  await click('[aria-label="OLD_DB 선택 해제"]'); await click('.admin-db-options input');
  await click('.admin-form-actions [type=submit]'); await page.until(`document.querySelector('.admin-success')`);
  assert.equal(await page.eval(`window.__records.queries[0].target_db_name`), 'ORDER_DB');
  // 실행 유형과 바인드 JSON의 저장·재조회를 확인한다.
  assert.equal(await page.eval(`document.querySelector('#admin-field-query_type').value`), 'QUERY');
  for (const type of ['PROCEDURE', 'FUNCTION']) {
    await page.eval(`(() => { const el = document.querySelector('#admin-field-query_type'); el.value = '${type}'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const sql = type === 'PROCEDURE' ? 'BEGIN app.orders(:id, :result); END;' : 'BEGIN :result := app.total(:id); END;';
    const binds = JSON.stringify({ id: { dir: 'IN', type: 'STRING' }, result: { dir: 'OUT', type: type === 'PROCEDURE' ? 'CURSOR' : 'NUMBER' } });
    await fill('#admin-field-query_sql', sql); await fill('#admin-field-bind_config', binds);
    await click('.admin-form-actions [type=submit]'); await page.until(`document.querySelector('.admin-success')`); await loaded();
    assert.equal(await page.eval(`window.__records.queries[0].query_type`), type);
    assert.equal(await page.eval(`window.__records.queries[0].bind_config`), binds);
    assert.match(await page.eval(`document.querySelector('.admin-record').textContent`), type === 'PROCEDURE' ? /프로시저/ : /함수/);
    await click('.admin-record');
    await page.until(`document.querySelector('#admin-field-query_type')?.value === '${type}'`);
    assert.equal(await page.eval(`document.querySelector('#admin-field-bind_config').value`), binds);
  }
  await page.eval('window.__confirm = false');
  if (process.env.ADMIN_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.ADMIN_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await page.viewport(320, 760);
  assert.ok(await page.eval(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.admin').scrollWidth <= innerWidth`), '작은 화면에서 가로 넘침이 없다');
  await click('.admin-delete');
  assert.equal(await page.eval(`window.__records.queries.length`), 1, '삭제 취소 시 항목을 보존한다');
  await page.eval('window.__confirm = true'); await click('.admin-delete');
  await page.until(`!document.querySelector('.admin-editor')`);
  assert.equal(await page.eval(`window.__records.queries.length`), 0);
  await click('[aria-label="채팅으로 돌아가기"]');
  assert.equal(await page.eval(`document.querySelector('.composer textarea').value`), chatDraft);
  assert.ok(await page.eval(`document.querySelector('.chat').clientHeight > 0`));
  assert.ok(await page.eval(`(() => { const el = document.querySelector('.composer textarea'); return el.clientHeight >= el.scrollHeight || getComputedStyle(el).overflowY === 'auto'; })()`), '관리 화면에서 창 크기를 바꿔도 여러 줄 초안이 숨지 않는다');
  await page.viewport(1000, 760);
  await page.eval(`window.__chatReply = ${JSON.stringify(Array.from({ length: 55 }, (_, i) => `문단 ${i}: 검토 중인 긴 답변입니다.`).join('\n\n'))}`);
  await click('.composer .send');
  await page.until(`document.querySelector('.bubble.assistant') && !document.querySelector('.typing')`);
  await page.until(`(() => { const el = document.querySelector('.chat'); return el.scrollHeight > 1500 && el.scrollHeight - el.clientHeight - el.scrollTop < 8; })()`);
  await page.wheel(500, 350, -700); await sleep(700);
  const readingPosition = await page.eval(`document.querySelector('.chat').scrollTop`);
  await click('[aria-label="관리자 화면 열기"]'); await loaded();
  await click('[aria-label="채팅으로 돌아가기"]'); await sleep(500);
  const returnedPosition = await page.eval(`document.querySelector('.chat').scrollTop`);
  assert.ok(Math.abs(returnedPosition - readingPosition) < 3, `관리 화면 왕복 뒤 읽던 대화 위치를 유지한다: ${readingPosition} → ${returnedPosition}`);
  await page.eval('window.__requireToken = true'); await click('[aria-label="관리자 화면 열기"]');
  await page.until(`document.querySelector('#admin-token')`);
  await fill('#admin-token', 'wrong-key'); await click('.admin-auth [type=submit]');
  await page.until(`document.querySelector('.admin-auth .admin-error')`);
  assert.match(await page.eval(`document.querySelector('.admin-auth .admin-error').textContent`), /인증에 실패했습니다/);
  await fill('#admin-token', 'test-admin-key'); await click('.admin-auth [type=submit]');
  await page.until(`document.querySelector('.admin-record')`);
  await click('[aria-label="채팅으로 돌아가기"]'); await click('[aria-label="관리자 화면 열기"]');
  await page.until(`document.querySelector('#admin-token')`);
  assert.equal(await page.eval(`document.querySelector('#admin-token').value`), '', '인증 키는 관리자 화면을 닫으면 폐기된다');
});
}
