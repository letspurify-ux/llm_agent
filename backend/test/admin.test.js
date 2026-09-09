import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter, createAdminStore, validateAdminRecord } from '../src/admin.js';

const database = { db_name: 'OPS', db_type: 'oracle', connection_info: 'localhost:1521/FREEPDB1', db_user: 'reader', db_password: 'ENV:OPS_PASSWORD' };
const query = { query_name: 'orders', query_desc: '', query_sql: 'SELECT * FROM orders WHERE id = :id', input_desc: 'id: 숫자', output_desc: '', target_db_name: 'OPS' };

test('관리 데이터 검증: 필수값·DB 유형·문자/바이트 상한·조회 SQL', () => {
  assert.deepEqual(validateAdminRecord('databases', database), database);
  assert.equal(validateAdminRecord('knowledge', { title: ' 문서 ', content: '\n본문\n' }).content, '\n본문\n');
  assert.equal(validateAdminRecord('knowledge', { title: '😀'.repeat(200), content: '본문' }).title.length, 400);
  for (const [kind, body] of [
    ['knowledge', { title: ' ', content: 'a' }], ['knowledge', { title: 'a', content: '가'.repeat(21846) }],
    ['methods', { title: 'a', method: [] }], ['databases', { ...database, db_type: 'mysql' }],
    ['databases', { ...database, db_name: 'A;B' }], ['databases', { ...database, db_password: 'ENV:' }],
    ['queries', { ...query, query_sql: 'DELETE FROM orders' }], ['queries', { ...query, target_db_name: ' ; ' }],
    ['queries', { ...query, input_desc: 'a'.repeat(1001) }],
  ]) assert.throws(() => validateAdminRecord(kind, body), { status: 400 });
  assert.throws(() => validateAdminRecord('__proto__', {}), { status: 404 });
  assert.throws(() => validateAdminRecord('constructor', {}), { status: 404 });
  assert.equal(validateAdminRecord('queries', { ...query, target_db_name: 'OPS; ops; REPORT' }).target_db_name, 'OPS;REPORT');
});

test('비밀번호를 비워 수정하면 기존 값을 덮어쓰지 않고, 새 등록에는 비밀번호가 필요하다', () => {
  const updated = validateAdminRecord('databases', { ...database, db_password: '' }, true);
  assert.equal(Object.hasOwn(updated, 'db_password'), false);
  assert.throws(() => validateAdminRecord('databases', { ...database, db_password: '' }), { status: 400 });
  assert.equal(validateAdminRecord('databases', { ...database, db_password: '  secret  ' }).db_password, '  secret  ');
});

test('검색은 비밀번호를 제외한 전체 필드에 바인드하고, 범위를 벗어난 페이지를 보정한다', async () => {
  const statements = [];
  const store = createAdminStore(async (sql, args) => {
    statements.push({ sql, args });
    return sql.includes('COUNT(*)') ? [{ total: 22n }] : [];
  });
  const result = await store.list('queries', { q: "'%_ OR 1=1", page: '99' });
  assert.equal(result.page, 2);
  assert.equal(result.total, 22);
  assert.equal(statements[1].args.at(-1), 20);
  assert.match(statements[0].sql, /LOCATE\(\?, query_sql\)/);
  assert.match(statements[0].sql, /LOCATE\(\?, input_desc\)/);
  assert.ok(!statements[0].sql.includes("'%_"));
  statements.length = 0;
  await store.list('databases', { q: 'secret' });
  assert.ok(statements.every(s => !s.sql.includes('db_password')));
  await assert.rejects(store.list('knowledge', { page: '-1' }), { status: 400 });
  await assert.rejects(store.list('knowledge', { q: ['bad'] }), { status: 400 });
  await assert.rejects(store.get('knowledge', '1 OR 1=1'), { status: 400 });
});

test('수정·삭제는 읽어 온 revision이 없으면 DB를 변경하지 않고 거부한다', async () => {
  const fail = () => { throw new Error('DB에 닿아서는 안 된다'); };
  const store = createAdminStore(fail, fail);
  for (const revision of [undefined, '', '*', 'not-a-revision']) {
    await assert.rejects(store.save('knowledge', { title: '제목', content: '내용' }, 1, revision), { status: 428 });
    await assert.rejects(store.remove('knowledge', 1, revision), { status: 428 });
  }
});

test('관리 API는 인증·잘못된 본문·충돌·DB 실패에 JSON으로 답하며 자격증명을 노출하지 않는다', async t => {
  const store = {
    list: async () => ({ items: [], total: 0 }),
    save: async (kind, body) => { throw Object.assign(new Error(`SQL contains secret: ${body.db_password}`), { code: body.code }); },
  };
  const app = express();
  app.use('/api/admin', createAdminRouter({ store, token: 'test-key' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/databases`;
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1', 'X-Admin-Token': 'test-key' };
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { ...headers, 'X-Admin-Token': 'wrong' } })).status, 401);
  const valid = await fetch(url, { headers });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{broken' })).status, 400);
  for (const [code, status] of [['ER_DUP_ENTRY', 409], ['ER_TABLEACCESS_DENIED_ERROR', 503], ['ER_CONNECTION_LOST', 500]]) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ db_password: 'do-not-leak', code }) });
    assert.equal(res.status, status);
    assert.ok(!(await res.text()).includes('do-not-leak'));
  }
});
