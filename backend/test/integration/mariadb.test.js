import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mariadb from 'mariadb';
import express from 'express';
import { closePool, loadChunkRanges, loadQueriesByNames, loadQueriesMentionedIn, insertChatLog } from '../../src/db.js';
import { syncEmbeddings, syncSummary, SKIP } from '../../src/embed-sync.js';
import { handleQuestion } from '../../src/agent.js';
import { buildItems } from '../../src/chunk.js';
import { searchKnowledge, searchQaMethods, searchQueries } from '../../src/search.js';
import { vector } from '../fixtures/vector.js';
import { EMBEDDING_MODEL, normalizeEmbedding } from '../../src/embedding.js';
import { SEARCH_LIMIT } from '../../src/constants.js';
import { buildPrompt } from '../../src/llm-openai.js';
import { llm, sanitizeDecision } from '../../src/llm.js';
import { runQuery } from '../../src/oracle.js';
import { createAdminRouter, createAdminStore } from '../../src/admin.js';

const exec = promisify(execFile);
const networkFetch = globalThis.fetch;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sqlFile = name => readFile(new URL(`../../sql/${name}`, import.meta.url), 'utf8');
let dir, server, conn;
let embeddedTexts = [];
// 임베딩 서버의 응답 모양. 'ok' 외의 값은 아래 실패 갈래 테스트가 try/finally로 되돌린다 —
// 이 대역이 모든 테스트에 공유되므로 되돌리지 않으면 뒤 테스트가 남의 고장을 물려받는다.
let embedMode = 'ok';
let embedCalls = 0;
let searchStatements = [];
let registryStatements = [];
// 대역이 만드는 벡터의 one-hot 위치 — 텍스트만으로 정해진다. 응답 순서가 뒤바뀌어도 어느 행의
// 벡터인지 이 값으로 되짚을 수 있다 (embedding.js가 index로 짝짓는 것을 검증하는 근거).
const slotOf = text => createHash('sha256').update(text).digest().readUInt16BE(0) % 1024;

test('관리자 검토: 다른 화면의 저장 내용을 오래된 수정·삭제가 덮어쓰지 않는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const store = createAdminStore();
  const first = await store.save('knowledge', { title: '동시 편집', content: '원문' });
  const saved = await store.save('knowledge', { title: first.title, content: '다른 관리자가 저장함' }, first.seq, first.revision);
  await assert.rejects(store.save('knowledge', { title: first.title, content: '오래된 화면의 수정' }, first.seq, first.revision), { status: 409 });
  await assert.rejects(store.remove('knowledge', first.seq, first.revision), { status: 409 });
  assert.equal((await store.get('knowledge', first.seq)).content, saved.content);
  const concurrent = await Promise.allSettled(['동시 변경 A', '동시 변경 B'].map(content =>
    store.save('knowledge', { title: first.title, content }, first.seq, saved.revision)));
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
});

test('관리자 검토: HTTP 수정·삭제의 If-Match와 비밀번호 변경 감지가 DB까지 연결된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const app = express();
  app.use('/api/admin', createAdminRouter({ token: 'test-key' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/admin/databases`;
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1', 'X-Admin-Token': 'test-key' };
  try {
    const db = { db_name: 'OPS', db_type: 'oracle', connection_info: 'localhost:1521/FREEPDB1', db_user: 'reader', db_password: 'first-secret' };
    const created = await networkFetch(base, { method: 'POST', headers, body: JSON.stringify(db) });
    assert.equal(created.status, 201);
    const row = await created.json();
    const tag = created.headers.get('etag');
    assert.equal(tag, `"${row.revision}"`);
    assert.ok(!JSON.stringify(row).includes('first-secret'));
    assert.equal(Object.hasOwn(row, '_fingerprint'), false);
    assert.equal(Object.hasOwn(row, 'db_password'), false);
    const url = `${base}/${row.seq}`;
    const same = await networkFetch(url, { headers });
    assert.equal(same.headers.get('etag'), tag, '읽기만 하면 revision이 바뀌지 않는다');
    const body = JSON.stringify({ ...db, db_password: 'second-secret' });
    assert.equal((await networkFetch(url, { method: 'PUT', headers, body })).status, 428);
    const changed = await networkFetch(url, { method: 'PUT', headers: { ...headers, 'If-Match': tag }, body });
    assert.equal(changed.status, 200);
    const next = await changed.json();
    const nextTag = changed.headers.get('etag');
    assert.notEqual(nextTag, tag, '비밀번호만 바뀌어도 오래된 수정을 차단한다');
    assert.ok(!JSON.stringify(next).includes('second-secret'));
    assert.equal((await networkFetch(url, { method: 'PUT', headers: { ...headers, 'If-Match': tag }, body })).status, 409);
    assert.equal((await networkFetch(url, { method: 'DELETE', headers })).status, 428);
    assert.equal((await networkFetch(url, { method: 'DELETE', headers: { ...headers, 'If-Match': tag } })).status, 409);
    assert.equal((await networkFetch(url, { method: 'DELETE', headers: { ...headers, 'If-Match': nextTag } })).status, 204);
    assert.equal((await networkFetch(url, { headers })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('관리자 검토: 대상 DB 이름 둘레의 탭·개행·유니코드 공백도 사용 중 참조다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const store = createAdminStore();
  const db = await store.save('databases', { db_name: 'OPS', db_type: 'oracle', connection_info: 'localhost:1521/FREEPDB1', db_user: 'reader', db_password: 'private-value' });
  for (const space of ['\t', '\r\n', '\u00a0', '\u2003', '\u2028', '\u3000', '\ufeff']) {
    await conn.query('DELETE FROM query_registry');
    await conn.query('INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, ?, ?)', ['uses_ops', 'SELECT 1 FROM dual', `UNKNOWN;${space}OPS${space}`]);
    await assert.rejects(store.remove('databases', db.seq, db.revision), { status: 409 }, `공백 ${JSON.stringify(space)}`);
  }
});

test('관리자 CRUD·전체 검색·페이지 이동·참조 보호는 실제 MariaDB에 반영된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const store = createAdminStore();
  let db = await store.save('databases', { db_name: 'OPS', db_type: 'oracle', connection_info: 'localhost:1521/FREEPDB1', db_user: 'reader', db_password: 'private-value' });
  assert.equal(db.has_password, 1);
  assert.equal(Object.hasOwn(db, 'db_password'), false);
  db = await store.save('databases', { ...db, db_password: '', db_user: 'new_reader' }, db.seq, db.revision);
  assert.equal((await conn.query('SELECT db_password FROM target_db WHERE seq = ?', [db.seq]))[0].db_password, 'private-value');
  let q = await store.save('queries', { query_name: 'orders', query_desc: '주문 조회', input_desc: 'customer_id: 고객 식별자', query_sql: 'SELECT * FROM orders WHERE customer_id = :customer_id', output_desc: '주문일', target_db_name: 'ops' });
  assert.equal(q.target_db_name, 'OPS');
  assert.equal((await store.list('queries', { q: ':customer_id' })).total, 1);
  assert.equal((await store.list('queries', { q: '주문일' })).total, 1);
  assert.equal((await store.list('databases', { q: 'new_reader' })).total, 1);
  assert.equal((await store.list('databases', { q: 'private-value' })).total, 0);
  // 기존 SQL 입력의 공백·대소문자, DB collation의 악센트 동등성도 참조 검사에서 지킨다.
  await conn.query("UPDATE query_registry SET target_db_name = ' UNKNOWN ; óps ' WHERE seq = ?", [q.seq]);
  await assert.rejects(store.remove('databases', db.seq, db.revision), { status: 409 });
  await assert.rejects(store.save('databases', { ...db, db_name: 'RENAMED', db_password: '' }, db.seq, db.revision), { status: 409 });
  q = await store.get('queries', q.seq);
  q = await store.save('queries', { ...q, target_db_name: 'OPS' }, q.seq, q.revision);
  const method = await store.save('methods', { title: '주문 절차', method: 'orders 쿼리로 주문을 조회합니다.' });
  await assert.rejects(store.remove('queries', q.seq, q.revision), { status: 409 });
  await assert.rejects(store.save('queries', { ...q, query_name: 'new_orders' }, q.seq, q.revision), { status: 409 });
  await assert.rejects(store.save('queries', { ...q, query_name: 'bad', target_db_name: 'MISSING' }), { status: 400 });
  assert.equal((await store.list('queries')).total, 1, '실패한 저장은 롤백된다');
  for (let i = 0; i < 23; i++) await store.save('knowledge', { title: `문서 ${i}`, content: i === 0 ? '할인율 10%_literal' : '검색용 본문' });
  assert.equal((await store.list('knowledge')).items.length, 20);
  assert.equal((await store.list('knowledge', { page: '2' })).items.length, 3);
  assert.equal((await store.list('knowledge', { q: '%_' })).total, 1);
  assert.equal((await store.list('knowledge', { q: "' OR 1=1 --" })).total, 0);
  let doc = await store.get('knowledge', (await store.list('knowledge', { q: '%_' })).items[0].seq);
  doc = await store.save('knowledge', { title: doc.title, content: '수정한 본문' }, doc.seq, doc.revision);
  assert.equal((await store.get('knowledge', doc.seq)).content, '수정한 본문');
  await store.remove('knowledge', doc.seq, doc.revision);
  await assert.rejects(store.get('knowledge', doc.seq), { status: 404 });
  await store.remove('methods', method.seq, method.revision);
  await store.remove('queries', q.seq, q.revision);
  await store.remove('databases', db.seq, db.revision);
  assert.equal((await store.databaseOptions()).length, 0);
});

test('실제 DB에 등록한 보충 평면 문자의 대상 DB 이름을 검색·선택·이력에서 보존한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const targetName = '조회_😀'.repeat(25);
  await conn.query('INSERT INTO target_db (db_name, connection_info) VALUES (?, ?)', [targetName, 'fixture.invalid']);
  await conn.query('INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, ?, ?)',
    ['batch_job_status', 'SELECT 1 FROM dual WHERE :job_id IS NOT NULL', `OPS;${targetName}`]);
  const [stored] = await conn.query('SELECT db_name, CHAR_LENGTH(db_name) AS chars FROM target_db');
  assert.equal(stored.chars, 100);
  assert.equal(stored.db_name, targetName);
  const snapshots = [];
  let turn = 0;
  const result = await handleQuestion('등록된 대상 DB 조회', [], { deps: {
    run: runQuery,
    decide: async c => {
      snapshots.push(buildPrompt(c));
      return sanitizeDecision([
        { action: 'search', text: 'batch_job_status', targets: ['query'] },
        { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' }, target_db: targetName },
        { action: 'answer', answer: '조회 완료' },
      ][turn++]);
    },
  } });
  assert.ok(snapshots[1].includes(`대상DB(OPS | ${targetName})`), '등록된 후보 이름이 잘렸다');
  assert.equal(result.trace[1].error, undefined);
  assert.equal(result.trace[1].targetDb, targetName);
  assert.equal(result.trace[1].rows[0].JOB_ID, 'BATCH001');
  assert.ok(snapshots[2].includes(`@${targetName} params=`));
});

before(async () => {
  // 기존 서버·.env의 DB는 사용하지 않는다. TCP도 열지 않는 임시 DB다.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'backend-mariadb-')));
  await exec(process.env.MARIADB_INSTALL_DB || 'mariadb-install-db', [
    '--no-defaults', `--datadir=${dir}`, '--auth-root-authentication-method=normal', '--skip-test-db',
  ], { timeout: 60_000 });
  const socketPath = join(dir, 'db.sock');
  server = spawn(process.env.MARIADBD || 'mariadbd', [
    '--no-defaults', `--datadir=${dir}`, `--socket=${socketPath}`, `--pid-file=${join(dir, 'db.pid')}`,
    `--log-error=${join(dir, 'db.log')}`, '--skip-networking', '--innodb-buffer-pool-size=32M',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    try { conn = await mariadb.createConnection({ socketPath, user: 'root', multipleStatements: true, connectTimeout: 500 }); break; }
    catch { if (server.exitCode !== null) break; await sleep(50); }
  }
  assert.ok(conn, `임시 MariaDB 기동 실패: ${await readFile(join(dir, 'db.log'), 'utf8').catch(() => '')}`);
  const createPool = mariadb.createPool.bind(mariadb);
  mock.method(mariadb, 'createPool', options => {
    const pool = createPool({ ...options, socketPath, user: 'root', password: '', database: 'llm_agent' });
    const acquire = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await acquire();
      return new Proxy(connection, { get(target, key) {
        if (key === 'query') return (sql, ...args) => {
          if (sql.startsWith('SET STATEMENT') || sql.includes('IGNORE INDEX (embedding)')) searchStatements.push({ sql, args });
          if (/^SELECT .* FROM query_registry/.test(sql)) registryStatements.push({ sql, args });
          return target.query(sql, ...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    return pool;
  });
  process.env.EMBEDDING_URL = 'http://test.invalid/v1';
  process.env.ORACLE_MOCK = '1';
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const { input } = JSON.parse(init.body);
    embedCalls++;
    // 5xx는 서버 사정(재시도 가치 있음), 400은 이 입력의 거부(재시도해도 같다) — embedding.js가 그 둘을 가른다.
    if (embedMode === 'down') return new Response('{"error":"boom"}', { status: 503 });
    if (embedMode.startsWith('reject:') && input.some(text => text.includes(embedMode.slice(7)))) {
      return new Response('{"error":"rejected"}', { status: 400 });
    }
    embeddedTexts.push(...input);
    const data = input.map((text, index) =>
      ({ index, embedding: embedMode === 'zero' ? Array(1024).fill(0) : vector(slotOf(text)) }));
    // vLLM·TEI의 continuous batching은 실제로 응답 순서를 바꾼다 (index는 그대로다).
    return new Response(JSON.stringify({ data: embedMode === 'shuffle' ? data.slice().reverse() : data }));
  });
}, { timeout: 60_000 });

after(async () => {
  await closePool();
  await conn?.end();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  mock.restoreAll();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('청크 마이그레이션은 기존 벡터를 보존하고 구 테이블 제거 후에도 재실행된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query('CREATE TABLE vec_store (src VARCHAR(40), seq INT, embed_hash CHAR(32), embedding VECTOR(1024))');
  const vector = JSON.stringify(Array.from({ length: 1024 }, (_, i) => Number(i === 0)));
  await conn.query("INSERT INTO vec_store VALUES ('qa_method', 7, REPEAT('a', 32), VEC_FromText(?))", [vector]);
  const migration = await sqlFile('migrate-chunk.sql');
  await conn.query(migration);
  await conn.query('DROP TABLE vec_store');
  await conn.query(migration);
  assert.equal((await conn.query('SELECT embed_hash FROM vec_qa_method WHERE seq = 7'))[0].embed_hash, 'a'.repeat(32));
});

test('실제 DB에서 스키마·시드·동기화가 멱등하고 원문 수정·삭제가 반영된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const seed = await sqlFile('seed.sql');
  await conn.query(seed); await conn.query(seed);
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM knowledge'))[0].n), 2);
  const first = await syncEmbeddings();
  assert.equal(first.failed, 0);
  assert.ok(first.embedded > 0);
  embeddedTexts = [];
  const second = await syncEmbeddings();
  assert.equal(second.embedded, 0);
  assert.deepEqual(embeddedTexts, []);
  // chunk_no는 1부터 이어지는 번호다 — 0부터 매기면 buildItems의 'closed(no) → no < 1'과 확대 창
  // (agent.js growItem의 Math.max(1, …))이 첫 조각을 문서 밖으로 보고 그 조각을 영영 읽지 못한다.
  // 그런데 그 실패는 '(확대 가능)'이 사라지지 않는 것으로만 보인다 — 오류가 남지 않아 테스트가 유일한 방어선이다.
  const 번호 = (await conn.query('SELECT doc_seq, chunk_no, chunk_of FROM knowledge_chunk ORDER BY doc_seq, chunk_no'));
  const 문서별 = new Map();   // Map.groupBy는 Node 21+다 — 이 저장소의 하한은 20이다 (package.json engines)
  for (const r of 번호) 문서별.set(r.doc_seq, [...(문서별.get(r.doc_seq) ?? []), r]);
  for (const [doc, rows] of 문서별) {
    assert.deepEqual(rows.map(r => r.chunk_no), rows.map((_, i) => i + 1), `문서 ${doc}의 chunk_no는 1부터 이어진다`);
    assert.ok(rows.every(r => r.chunk_of === rows.length), `문서 ${doc}의 chunk_of는 그 문서의 조각 수다`);
  }
  await conn.query("UPDATE knowledge SET content = '갱신된 원문' WHERE seq = 1");
  await syncEmbeddings();
  assert.equal((await conn.query('SELECT content FROM knowledge_chunk WHERE doc_seq = 1'))[0].content, '갱신된 원문');
  assert.ok(embeddedTexts.some(text => text.includes('갱신된 원문')));
  await conn.query('DELETE FROM knowledge WHERE seq = 1');
  await syncEmbeddings();
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM knowledge_chunk WHERE doc_seq = 1'))[0].n), 0);
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM vec_knowledge_chunk v LEFT JOIN knowledge_chunk c USING(seq) WHERE c.seq IS NULL'))[0].n), 0);
});

test('재임베딩 실패 시 세 소스 모두 이전 벡터로 새 본문을 반환하지 않고 복구 후 다시 검색된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO knowledge (title, content) VALUES ('검증 지식', 'original')");
  await conn.query("INSERT INTO qa_method (title, method) VALUES ('검증 절차', 'original')");
  await conn.query("INSERT INTO query_registry (query_name, query_desc, query_sql, target_db_name) VALUES ('verify_query', 'original', 'SELECT 1 FROM dual', 'DB')");
  const cases = [
    { table: 'knowledge_chunk', search: searchKnowledge, text: '검증 지식\noriginal' },
    { table: 'qa_method', search: searchQaMethods, text: '검증 절차\noriginal' },
    { table: 'query_registry', search: searchQueries, text: 'verify_query\noriginal\n\n' },
  ];
  assert.equal((await syncEmbeddings()).embedded, 3);
  for (const c of cases) assert.equal((await c.search(c.text)).length, 1);
  await conn.query("UPDATE knowledge SET content = 'changed'");
  await conn.query("UPDATE qa_method SET method = 'changed'");
  await conn.query("UPDATE query_registry SET query_desc = 'changed'");
  try {
    embedMode = 'reject:changed';
    assert.equal((await syncEmbeddings()).failed, 3);
    for (const c of cases) {
      assert.equal(Number((await conn.query(`SELECT COUNT(*) n FROM vec_${c.table}`))[0].n), 1,
        '이전 벡터가 남아 있는 실패 경로를 검증한다');
      assert.deepEqual(await c.search(c.text), [], `${c.table}: 이전 내용으로 새 본문을 검색하면 안 된다`);
    }
  } finally { embedMode = 'ok'; }
  assert.equal((await syncEmbeddings()).embedded, 3);
  for (const c of cases) {
    const text = c.text.replace('original', 'changed');
    assert.equal((await c.search(text)).length, 1, `${c.table}: 복구 후 최신 본문을 찾는다`);
    await conn.query(`UPDATE vec_${c.table} SET embed_hash = REPEAT('0', 32)`);
    assert.deepEqual(await c.search(text), [], '본문이 같아도 모델 등 해시가 다르면 제외한다');
  }
});

test('실제 쿼리 등록 검색에서 조회 실행·표 참조까지 이어진다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query(await sqlFile('seed.sql'));
  const script = [
    { action: 'search', text: 'today_date', targets: ['query'] },
    { action: 'run_query', query_name: 'today_date', params: {} },
    { action: 'answer', answer: '```table\nstep: 2\n```' },
  ];
  const result = await handleQuestion('DB 서버의 현재 시각을 알려줘', [], { deps: { decide: async () => script.shift() } });
  assert.equal(result.search.queries, 1);
  assert.equal(result.trace[1].targetDb, 'ORDER_DB');
  assert.equal(result.trace[1].rows.length, 1);
  assert.match(result.answer, /TODAY/);
  assert.match(result.answer, /\d{4}-\d{2}-\d{2}/);
});

// loadQueriesByNames의 계약은 '요청한 이름 순서로 돌려준다'이다. 그 순서가 프롬프트 예산의
// 자르는 기준이라(꼬리부터 버린다) 순서가 뒤집히면 다단계 절차의 '1단계'가 잘려 나간다 —
// 에이전트는 절차를 시작하지도 못하는데 어디에도 오류가 남지 않는다. IN(...)은 인자 순서를
// 결과 순서로 보장하지 않으므로 이 정렬은 실물 DB에서만 의미가 있다.
test('지목한 쿼리는 첫 자리까지 요청한 순서대로 돌아온다 (대소문자·중복 포함)', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query(await sqlFile('seed.sql'));
  // seed의 '고객 주문 상태 확인'은 find_customer_id가 1단계다.
  const names = ['find_customer_id', 'batch_job_status'];
  assert.deepEqual((await loadQueriesByNames(names)).map(r => r.query_name), names);
  // 등록 철자와 본문 표기가 대소문자만 달라도 그 행만 뒤로 밀리지 않는다.
  assert.deepEqual(
    (await loadQueriesByNames(['FIND_CUSTOMER_ID', 'Batch_Job_Status'])).map(r => r.query_name), names);
  // 같은 이름을 두 번 지목해도 기준은 처음 나온 자리다.
  assert.deepEqual(
    (await loadQueriesByNames(['find_customer_id', 'batch_job_status', 'find_customer_id']))
      .map(r => r.query_name), names);
  assert.deepEqual(await loadQueriesByNames([]), []);
});

// 검색이 넘기는 범위 목록은 모델 출력을 거친 값이라 빈 칸이 섞일 수 있다. 그것을 걸러내지
// 않으면 바인드 수가 어긋나거나 조회 자체가 터져 질문 한 건이 통째로 실패한다.
test('범위 목록에 빈 칸이 섞여도 성한 범위만 읽고 터지지 않는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query('INSERT INTO knowledge (title, content) VALUES (?, ?)', ['범위', '가'.repeat(1200)]);
  await syncEmbeddings();
  const only = await loadChunkRanges([{ doc_seq: 1, from: 1, to: 9 }]);
  assert.ok(only.length >= 2);
  const mixed = await loadChunkRanges([null, undefined, { from: 1, to: 9 }, { doc_seq: 1, from: 1, to: 9 }]);
  assert.deepEqual(mixed.map(r => r.chunk_no), only.map(r => r.chunk_no));
  assert.deepEqual(await loadChunkRanges([null, undefined, {}]), []);
  assert.deepEqual(await loadChunkRanges(undefined), []);
});

// chat_log.trace는 JSON 컬럼이라 MariaDB가 INSERT에서 직접 검사한다 — 그 검사는 실물 DB에서만 드러난다.
// 모델이 낸 params에 짝 잃은 코드유닛이 있으면 JSON.stringify가 그것을 `\udXXX`로 내보내는데, 그 JSON은
// 검사를 통과하지 못해 **그 요청의 대화 로그 한 줄이 통째로** 사라진다(남는 것은 경고 한 줄뿐이다).
// 하필 모델 출력이 깨진 요청 — 가장 들여다볼 값어치가 있는 요청 — 만 데이터에서 빠지므로,
// 그 자리를 실물 컬럼으로 못 박는다 (직렬화 규칙 자체는 test/agent.test.js가 잰다).
test('모델이 낸 깨진 코드유닛이 있어도 대화 로그가 통째로 사라지지 않는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const HI = '\uD800', LO = '\uDC00';
  const trace = { v: 4, outcome: 'answered',
    steps: [{ query_name: 'q', params: { [`job${HI}`]: `BATCH${LO}` }, rows: [{ V: '정상' }] }] };
  await insertChatLog('질문', `답변${HI}`, trace);
  const [row] = await conn.query(
    'SELECT JSON_VALUE(trace, ?) AS outcome, JSON_VALUE(trace, ?) AS job, answer FROM llm_agent.chat_log ORDER BY seq DESC LIMIT 1',
    ['$.outcome', '$.steps[0].params.job']);
  assert.equal(row.outcome, 'answered', '분석 SQL이 읽을 수 있는 JSON으로 남아야 한다');
  assert.equal(row.job, 'BATCH');
  // answer는 MEDIUMTEXT라 커넥터가 UTF-8로 바꾸며 대체 문자가 된다 — 행이 남는다는 것이 계약이다
  assert.match(row.answer, /^답변/);
});

test('제목과 본문 사이 개행 이동도 원문 변경으로 감지해 청크를 갱신한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query('INSERT INTO knowledge (title, content) VALUES (?, ?)', ['제목\n첫 문단', '둘째 문단']);
  await syncEmbeddings();
  await conn.query('UPDATE knowledge SET title = ?, content = ? WHERE seq = 1', ['제목', '첫 문단\n둘째 문단']);
  await syncEmbeddings();
  const rows = await conn.query('SELECT title, content FROM knowledge_chunk WHERE doc_seq = 1');
  assert.deepEqual([...rows], [{ title: '제목', content: '첫 문단\n둘째 문단' }]);
  assert.equal((await syncEmbeddings()).chunks, 0, '갱신 후에는 다시 나누지 않는다');
});

test('실제 동기화로 문서 뒤쪽만 바뀌어도 이전 판본의 검색 근거를 확대하지 않는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const prefix = '가'.repeat(1000) + '나'.repeat(1000);
  await conn.query('INSERT INTO knowledge (title, content) VALUES (?, ?)', ['절차', prefix + '다'.repeat(1000)]);
  await syncEmbeddings();
  const chunks = await loadChunkRanges([{ doc_seq: 1, from: 1, to: 10 }]);
  assert.match(chunks[0].doc_hash, /^[a-f0-9]{32}$/);
  const [first] = buildItems([{ doc_seq: 1, rep: 1, from: 1, to: 1, dist: .1 }], chunks);
  await conn.query('UPDATE knowledge SET content = ? WHERE seq = 1', [prefix + '라'.repeat(1000)]);
  await syncEmbeddings();
  const current = await loadChunkRanges([{ doc_seq: 1, from: 1, to: 1 }]);
  assert.equal(current[0].content, chunks[0].content);
  assert.notEqual(current[0].doc_hash, chunks[0].doc_hash);
  const decisions = [
    { action: 'search', text: '절차', targets: ['knowledge'] },
    { action: 'expand', ids: [`k${first.seq}`] },
  ];
  let snapshot;
  const result = await handleQuestion('전체 절차', [], { deps: {
    search: async () => ({ knowledge: [first] }),
    decide: async c => {
      if (decisions.length) return decisions.shift();
      snapshot = structuredClone(c.knowledge);
      return { action: 'answer', answer: '확보한 구간으로 답변' };
    },
  } });
  assert.equal(snapshot[0].content, chunks[0].content);
  assert.match(result.trace.find(h => h.expand)?.note ?? '', /변경/);
});

// 성공 회차도 함께 잰다 — 실패만 단언하면 '언제나 1을 돌려주는' 회귀가 그대로 통과한다(변이 검사로 확인).
// 프로비저닝 스크립트가 이 코드로 성공을 판정하므로, 늘 1이면 정상 배포가 매번 실패로 기록된다.
test('동기화 CLI는 부분 저장 실패·청크 실패·DB 오류를 실패 코드로 알리고 풀을 닫는다 (성공은 0)', async t => {
  for (const mode of ['ok', 'vector', 'chunk', 'db']) {
    await t.test(mode, async () => {
      await conn.query(await sqlFile('schema.sql'));
      if (mode === 'ok') await conn.query("INSERT INTO qa_method (title, method) VALUES ('title', 'content')");
      if (mode === 'vector') await conn.query("INSERT INTO qa_method (title, method) VALUES ('title', 'content')");
      if (mode === 'chunk') {
        await conn.query("INSERT INTO knowledge (title, content) VALUES ('title', 'content')");
        await conn.query("CREATE TRIGGER fail_chunks BEFORE INSERT ON knowledge_chunk FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture chunk failure'");
      }
      if (mode === 'db') await conn.query('DROP TABLE vec_qa_method');
      const result = await exec(process.execPath, [
        '--import', fileURLToPath(new URL('../fixtures/cli-db.js', import.meta.url)),
        fileURLToPath(new URL('../../src/embed-sync.js', import.meta.url)),
      ], {
        timeout: 15_000,
        env: { ...process.env, BACKEND_TEST_DB_SOCKET: join(dir, 'db.sock'), BACKEND_TEST_BAD_VECTOR: mode === 'vector' ? '1' : '' },
      }).then(value => ({ ...value, code: 0 }), error => error);
      assert.equal(result.code, mode === 'ok' ? 0 : 1, `종료 코드로 결과를 알려야 한다: ${mode}`);
      assert.match(result.stdout, /\[test\] pool closed/, '어느 경로도 커넥션 풀을 닫아야 한다');
      if (mode === 'ok') assert.match(result.stdout, /embedding sync complete: created\/updated 1/);
    });
  }
});

// 임베딩 실패는 성격이 둘로 갈리고 호출부가 해야 할 일이 정반대다 (embedding.js EmbeddingError).
// 한 갈래로 뭉개지면 결과가 둘 다 나쁘다: 입력 한 건이 거부된 것을 '서버가 죽었다'로 읽으면 성한
// 행까지 매 주기 되풀이되며 뒤쪽 테이블의 고아 정리까지 멈추고, 반대로 서버 장애를 '이 행이 나쁘다'로
// 읽으면 멀쩡한 행이 실패로 집계된다. 둘 다 로그 말고는 드러나는 곳이 없어 회귀가 보이지 않는다.
test('임베딩 서버의 행 거부와 서버 장애를 갈라 다룬다 — 거부는 그 행만, 5xx는 회차를 접고 다음에 잇는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO qa_method (title, method) VALUES ('정상 A', '본문 A'), ('거부될 행', 'REJECTME 표식'), ('정상 B', '본문 B')");
  const stored = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM vec_qa_method'))[0].n);
  try {
    // ① 서버가 이 입력만 거부한다(400) — 배치를 갈라 성한 행은 진도를 내고 그 행만 실패로 센다.
    embedMode = 'reject:REJECTME';
    const rejected = await syncEmbeddings();
    assert.equal(rejected.failed, 1, '거부된 행만 실패로 세어야 한다');
    assert.equal(rejected.embedded, 2, '같은 배치의 성한 행은 저장돼야 한다');
    assert.equal(rejected.skipped, SKIP.NONE, '서버가 살아 있으므로 회차를 접지 않는다');
    assert.match(syncSummary(rejected), /skipped 1/, '요약이 건너뛴 행 수를 알려야 한다');
    assert.equal(await stored(), 2);
    // 해시가 갱신되지 않으므로 원본을 고치기 전까지 매 주기 다시 잡힌다.
    assert.equal((await syncEmbeddings()).failed, 1, '실패한 행은 다음 주기에 되돌아와야 한다');

    // ② 서버가 5xx — 이번 회차만 접는다. 아무것도 저장하지 않고 재시도 대상으로 남긴다.
    await conn.query("INSERT INTO qa_method (title, method) VALUES ('정상 C', '본문 C')");
    embedMode = 'down';
    embedCalls = 0;
    const down = await syncEmbeddings();
    // 죽은 서버에 행마다 매달리지 않는다 — 배치 한 번에 접는다. 매달리면 회차 하나가
    // 임베딩 타임아웃(60초) × 행 수만큼 늘어지고 그동안 GET_LOCK 커넥션을 쥔 채로 있다.
    assert.equal(embedCalls, 1, '닿지 못한 서버에 배치 한 번만 시도해야 한다');
    assert.equal(down.skipped, SKIP.UNAVAILABLE, '서버 장애는 행 문제와 다르게 보고해야 한다');
    assert.equal(down.embedded, 0);
    assert.equal(down.failed, 0, '서버가 죽은 것은 행의 실패가 아니다');
    assert.match(syncSummary(down), /could not reach/);
    assert.equal(await stored(), 2);
  } finally {
    embedMode = 'ok';
  }
  // ③ 서버가 돌아오면 거부됐던 행과 그 사이 들어온 행이 함께 이어진다.
  const recovered = await syncEmbeddings();
  assert.equal(recovered.skipped, SKIP.NONE);
  assert.equal(recovered.failed, 0);
  assert.equal(recovered.embedded, 2, '남겨둔 행을 다음 실행이 이어받아야 한다');
  assert.equal(await stored(), 4);
});

// 응답 항목에 index가 있는 이유가 순서를 보장하지 않기 때문이다 (vLLM/TEI의 continuous batching).
// 위치로 짝지으면 텍스트와 벡터가 어긋난 채 '올바른' 해시와 함께 저장돼 이후 동기화가 영영 고치지
// 못한다 — 검색이 엉뚱한 문서를 돌려주는 것으로만 드러나므로 오류가 한 줄도 남지 않는다.
test('임베딩 응답 순서가 뒤바뀌어도 index로 짝지어 행과 벡터가 어긋나지 않는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO qa_method (title, method) VALUES ('첫째', '본문 하나'), ('둘째', '본문 둘'), ('셋째', '본문 셋')");
  embeddedTexts = [];
  try {
    embedMode = 'shuffle';
    assert.equal((await syncEmbeddings()).failed, 0);
  } finally {
    embedMode = 'ok';
  }
  // 배치 한 번으로 끝나야 한다. index로 정렬하지 않으면 정합성 검사(index !== 위치)가 배치를 거부해
  // 행 단위 재시도로 물러나는데, 그때도 결과는 맞아서 저장된 벡터만 보면 구분되지 않는다 —
  // 세 행짜리 동기화가 임베딩 왕복 네 번이 되는 것이 유일한 흔적이다.
  assert.deepEqual(embeddedTexts, ['첫째\n본문 하나', '둘째\n본문 둘', '셋째\n본문 셋']);
  const rows = await conn.query(
    'SELECT q.title, q.method, VEC_ToText(v.embedding) AS vec FROM qa_method q JOIN vec_qa_method v USING (seq) ORDER BY q.seq');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const hot = JSON.parse(row.vec).findIndex(x => x > 0.5);
    assert.equal(hot, slotOf(`${row.title}\n${row.method}`), `${row.title}에 다른 행의 벡터가 저장됐다`);
  }
});

test('오래된 상위 후보와 고아 벡터 뒤의 정상 결과를 세 소스 모두 보충한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  for (let i = 1; i <= 61; i++) {
    await conn.query("INSERT INTO knowledge (title, content) VALUES (?, '본문')", [`지식 ${i}`]);
    await conn.query("INSERT INTO qa_method (title, method) VALUES (?, '본문')", [`절차 ${i}`]);
    await conn.query("INSERT INTO query_registry (query_name, query_desc, query_sql, target_db_name) VALUES (?, '본문', 'SELECT 1 FROM dual', 'DB')", [`query_${i}`]);
  }
  await syncEmbeddings();
  for (const [table, search] of [['knowledge_chunk', searchKnowledge], ['qa_method', searchQaMethods], ['query_registry', searchQueries]]) {
    const text = `candidate refill ${table}`;
    const slot = slotOf(text);
    const near = vector(slot);
    const far = vector(slot); far[slot] = 0.9; far[(slot + 1) % 1024] = 0.1;
    await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?), embed_hash = REPEAT('0', 32) WHERE seq <= 60`, [JSON.stringify(near)]);
    await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?) WHERE seq = 61`, [JSON.stringify(far)]);
    const result = await search(text);
    assert.equal(result.length, 1, `${table}: 상위 후보가 모두 오래된 벡터여도 정상 61번은 찾는다`);
    assert.equal(result[0].seq, 61);
    await conn.query(`DELETE FROM ${table} WHERE seq <= 60`);
    const orphanResult = await search(text);
    assert.equal(orphanResult.length, 1, `${table}: 고아 벡터가 검색 후보를 독점하지 않는다`);
    assert.equal(orphanResult[0].seq, 61);
  }
});

test('영벡터 응답은 동기화 실패로 남고 다음 정상 응답에서 자동 복구된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO knowledge (title, content) VALUES ('영벡터 복구', '본문')");
  try {
    embedMode = 'zero';
    const bad = await syncEmbeddings();
    assert.equal(bad.embedded, 0);
    assert.equal(bad.failed, 1);
    assert.equal(Number((await conn.query('SELECT COUNT(*) n FROM vec_knowledge_chunk'))[0].n), 0);
  } finally { embedMode = 'ok'; }
  assert.equal((await syncEmbeddings()).embedded, 1);
  assert.equal((await searchKnowledge('영벡터 복구\n본문')).length, 1);
});

test('기존 영벡터 복구 SQL은 정상 벡터를 보존하고 멱등하며 누락분만 재임베딩한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO knowledge (title, content) VALUES ('복구 지식', '본문'), ('정상 지식', '본문')");
  await conn.query("INSERT INTO qa_method (title, method) VALUES ('복구 절차', '본문')");
  await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES ('repair_query', 'SELECT 1 FROM dual', 'DB')");
  await syncEmbeddings();
  const good = (await conn.query('SELECT embed_hash, VEC_ToText(embedding) AS v FROM vec_knowledge_chunk WHERE seq = 2'))[0];
  for (const src of ['knowledge_chunk', 'qa_method', 'query_registry']) {
    await conn.query(`UPDATE vec_${src} SET embedding = VEC_FromText(?) WHERE seq = 1`, [JSON.stringify(Array(1024).fill(src === 'qa_method' ? 1e-23 : 0))]);
  }
  assert.equal((await syncEmbeddings()).embedded, 0, '기존 불량 벡터에는 성공으로 기록된 해시가 남아 있다');
  const repair = await sqlFile('repair-invalid-vectors.sql');
  await conn.query(repair);
  await conn.query(repair);
  assert.deepEqual((await conn.query('SELECT embed_hash, VEC_ToText(embedding) AS v FROM vec_knowledge_chunk WHERE seq = 2'))[0], good);
  const fixed = await syncEmbeddings();
  assert.equal(fixed.embedded, 3);
  assert.equal(fixed.failed, 0);
  assert.equal((await syncEmbeddings()).embedded, 0);
  assert.deepEqual((await searchKnowledge('복구 지식\n본문')).map(row => row.doc_seq), [1, 2],
    '복구한 최근접 지식이 먼저 나오고, 기존 정상 지식도 최소 개수 보충에 포함된다');
});

test('복구 SQL 실행 전의 기존 불량 벡터도 정상 검색 결과를 가리거나 적중으로 나오지 않는다', async t => {
  for (const [label, value] of [['영벡터', 0], ['극소 벡터', 1e-23]]) {
    await t.test(label, async () => {
      await conn.query(await sqlFile('schema.sql'));
      await conn.batch("INSERT INTO qa_method (title, method) VALUES (?, '본문')",
        Array.from({ length: 61 }, (_, i) => [`${label} 후보 ${i + 1}`]));
      await syncEmbeddings();
      const text = `invalid stored vector ${label}`;
      const good = vector(slotOf(text));
      await conn.query('UPDATE vec_qa_method SET embedding = VEC_FromText(?) WHERE seq <= 60',
        [JSON.stringify(Array(1024).fill(value))]);
      await conn.query('UPDATE vec_qa_method SET embedding = VEC_FromText(?) WHERE seq = 61', [JSON.stringify(good)]);
      const rows = await searchQaMethods(text);
      assert.deepEqual(rows?.map(r => r.seq), [61]);
    });
  }
});

test('정상 검색은 인덱스와 PK 후보 조회만 사용하고 무효 후보가 있을 때만 정확 검색한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const text = 'query plan healthy corpus';
  await conn.batch("INSERT INTO qa_method (title, method) VALUES (?, '본문')", Array.from({ length: 1000 }, (_, i) => [`문서 ${i}`]));
  await conn.query(`INSERT INTO vec_qa_method (seq, embed_hash, embedding)
    SELECT seq, MD5(CONCAT_WS(CHAR(10), ?, title, method)), VEC_FromText(?) FROM qa_method`,
    [EMBEDDING_MODEL, JSON.stringify(vector(slotOf(text)))]);
  await conn.query('ANALYZE TABLE qa_method, vec_qa_method');
  searchStatements = [];
  const hits = await searchQaMethods(text);
  assert.ok(hits.length > 0);
  assert.equal(searchStatements.length, 1, '정상 검색에 보충 조회가 추가되면 안 된다');
  assert.ok(hits.every(h => !('_stale' in h) && !('_invalid' in h)), '내부 상태를 검색 결과에 노출하지 않는다');
  const { sql, args } = searchStatements[0];
  const plan = await conn.query(sql.replace(' FOR\n', ' FOR EXPLAIN\n'), ...args);
  assert.equal(plan.find(r => r.table === 'vec_qa_method').key, 'embedding', '평상시 벡터 인덱스를 사용한다');
  assert.equal(plan.find(r => r.table === 't').type, 'eq_ref', '전체 본문 스캔 대신 후보 PK로 조회한다');
  await conn.query("UPDATE qa_method SET method = '바뀐 본문'");
  searchStatements = [];
  assert.deepEqual(await searchQaMethods(text), []);
  assert.equal(searchStatements.length, 2, '무효 후보는 한 번의 정확 검색으로 처리한다');
  const exact = searchStatements[1];
  const exactPlan = await conn.query(`EXPLAIN ${exact.sql}`, ...exact.args);
  assert.notEqual(exactPlan.find(r => r.table === 'v').key, 'embedding');
});

test('검증을 통과한 FP32 극단값도 DB에서 코사인 거리를 계산할 수 있다', async () => {
  for (const value of [1, 1e-10, 1e-20, 1e-23, 1e-24, 1e10, 1e18, 1e20]) {
    const v = normalizeEmbedding(Array(1024).fill(value));
    if (!v) continue;
    const encoded = JSON.stringify(v);
    const [r] = await conn.query('SELECT VEC_DISTANCE_COSINE(VEC_FromText(?), VEC_FromText(?)) AS d', [encoded, JSON.stringify(vector())]);
    assert.equal(typeof r.d, 'number', `값 ${value}: NULL 거리`);
    assert.ok(Number.isFinite(r.d) && Math.abs(r.d - (1 - 1 / Math.sqrt(1024))) < 0.001, `값 ${value}: 기준 벡터와의 거리 ${r.d}`);
  }
});

test('세 소스의 실제 검색은 가까운 순서·반환 상한을 지키고 문턱 밖에서도 최소 3건을 보충한다', async t => {
  await conn.query(await sqlFile('schema.sql'));
  for (let i = 1; i <= SEARCH_LIMIT + 2; i++) {
    await conn.query("INSERT INTO knowledge (title, content) VALUES (?, '본문')", [`검색 경계 지식 ${i}`]);
    await conn.query("INSERT INTO qa_method (title, method) VALUES (?, '본문')", [`검색 경계 절차 ${i}`]);
    await conn.query("INSERT INTO query_registry (query_name, query_desc, query_sql, target_db_name) VALUES (?, '본문', 'SELECT 1 FROM dual', 'DB')", [`boundary_query_${i}`]);
  }
  assert.equal((await syncEmbeddings()).failed, 0);
  for (const [table, search] of [['knowledge_chunk', searchKnowledge], ['qa_method', searchQaMethods], ['query_registry', searchQueries]]) {
    await t.test(table, async () => {
      const text = `distance and limit ${table}`;
      const slot = slotOf(text);
      const atDistance = distance => {
        const values = Array(1024).fill(0);
        values[slot] = 1 - distance;
        values[(slot + 1) % values.length] = Math.sqrt(1 - values[slot] ** 2);
        return JSON.stringify(values);
      };
      // 후보를 역순으로 가깝게 만든다. PK 순서를 관련도 순서로 오인하지 않게 한다.
      for (let i = 1; i <= SEARCH_LIMIT + 2; i++) {
        await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?) WHERE seq = ?`,
          [atDistance((SEARCH_LIMIT + 3 - i) / (SEARCH_LIMIT + 3) * 0.35), i]);
      }
      const ranked = await search(text);
      // ANN은 전수 검색과 다른 후보를 고를 수 있다. 같은 ID 집합 대신
      // 중복 없음·반환 상한·실제 거리순을 확인한다. 최근접 ID도 ANN의 보장은 아니다.
      assert.equal(ranked.length, SEARCH_LIMIT);
      assert.equal(new Set(ranked.map(row => row.seq)).size, ranked.length);
      assert.ok(ranked.every((row, i) => i === 0 || ranked[i - 1]._dist <= row._dist));

      // 문턱 안의 결과가 0·1·2건이면 가까운 순서로 3건, 3건 이상이면 문턱을 유지한다.
      // 반복 UPDATE 뒤 ANN은 가까운 행도 놓칠 수 있다. 개수·문턱의 정확한 경계는
      // 최근접 고아 후보로 정확 보충 경로를 실행해 검사한다. 정상 ANN 경로는 위에서 검사했다.
      await conn.query(`INSERT INTO vec_${table} (seq, embed_hash, embedding) VALUES (-1, 'orphan', VEC_FromText(?))`,
        [atDistance(0)]);
      for (const distances of [[0.6, 0.7, 0.8, 0.9], [0.39, 0.41, 0.5, 0.6],
        [0.2, 0.39, 0.41, 0.6], [0.1, 0.2, 0.39, 0.41], [0.1, 0.2, 0.3, 0.39]]) {
        await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?) WHERE seq > 0`, [atDistance(1)]);
        for (const [i, distance] of distances.entries()) {
          await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?) WHERE seq = ?`, [atDistance(distance), i + 1]);
        }
        const count = Math.min(SEARCH_LIMIT, Math.max(3, distances.filter(d => d <= 0.4).length));
        searchStatements = [];
        const rows = await search(text);
        assert.ok(searchStatements.some(entry => entry.sql.includes('IGNORE INDEX (embedding)')), '정확 보충 경로가 실행되어야 한다');
        assert.deepEqual(rows.map(row => row.seq), Array.from({ length: count }, (_, i) => i + 1), `${table}: ${distances}`);
        assert.ok(rows.every((row, i) => i === 0 || rows[i - 1]._dist <= row._dist));
      }
      await conn.query(`DELETE FROM vec_${table} WHERE seq = -1`);

      // 가까운 상위 후보가 무효여도 정확 검색으로 현재 유효한 최근접 3건을 보충한다.
      for (let i = 1; i <= SEARCH_LIMIT + 2; i++) {
        await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?) WHERE seq = ?`, [atDistance(0.5 + i / 100), i]);
      }
      await conn.query(`UPDATE vec_${table} SET embed_hash = 'stale', embedding = VEC_FromText(?) WHERE seq = 1`, [atDistance(0.1)]);
      await conn.query(`UPDATE vec_${table} SET embedding = VEC_FromText(?) WHERE seq = 2`, [JSON.stringify(Array(1024).fill(0))]);
      assert.deepEqual((await search(text)).map(row => row.seq), [3, 4, 5]);

      // 유효한 자료 자체가 모자라면 있는 만큼만 반환한다. 빈 테이블은 정상 0건이다.
      await conn.query(`DELETE FROM vec_${table} WHERE seq NOT IN (3, 4)`);
      assert.deepEqual((await search(text)).map(row => row.seq), [3, 4]);
      await conn.query(`DELETE FROM vec_${table}`);
      assert.deepEqual(await search(text), []);
    });
  }
});

test('지식 청크가 한 문서에 몰려도 병합 후 가까운 문서로 최소 3건을 보충한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const count = SEARCH_LIMIT * 3 + 5;
  for (let doc = 1; doc <= 5; doc++) {
    await conn.query("INSERT INTO knowledge (title, content) VALUES (?, '본문')", [`최소 결과 문서 ${doc}`]);
    const chunks = doc === 1 ? count : 1;
    for (let no = 1; no <= chunks; no++) {
      await conn.query(`INSERT INTO knowledge_chunk (doc_seq, chunk_no, chunk_of, doc_hash, title, content)
        VALUES (?, ?, ?, 'fixture', ?, ?)`, [doc, no, chunks, `문서 ${doc}`, `문서 ${doc} 청크 ${no}`]);
    }
  }
  const text = 'minimum merged knowledge';
  const slot = slotOf(text);
  const atDistance = distance => {
    const values = Array(1024).fill(0);
    values[slot] = 1 - distance;
    values[(slot + 1) % values.length] = Math.sqrt(1 - values[slot] ** 2);
    return JSON.stringify(values);
  };
  for (let doc = 1; doc <= 5; doc++) {
    await conn.query(`INSERT INTO vec_knowledge_chunk (seq, embed_hash, embedding)
      SELECT seq, MD5(CONCAT_WS(CHAR(10), ?, title, content)), VEC_FromText(?) FROM knowledge_chunk WHERE doc_seq = ?`,
      [EMBEDDING_MODEL, atDistance(0.5 + doc / 20), doc]);
  }
  // 다른 가까운 문서도 판본이 오래됐거나 벡터가 무효하면 보충 대상에서 제외한다.
  await conn.query("UPDATE vec_knowledge_chunk SET embed_hash = 'stale' WHERE seq = ?", [count + 1]);
  await conn.query('UPDATE vec_knowledge_chunk SET embedding = VEC_FromText(?) WHERE seq = ?', [JSON.stringify(Array(1024).fill(0)), count + 2]);
  const before = embedCalls;
  searchStatements = [];
  const rows = await searchKnowledge(text);
  assert.deepEqual(rows.map(row => row.doc_seq), [1, 4, 5]);
  assert.ok(rows.every((row, i) => i === 0 || rows[i - 1]._dist <= row._dist));
  assert.equal(embedCalls - before, 1, '문서 보충에서도 같은 질의 임베딩을 재사용한다');
  assert.equal(searchStatements.filter(entry => entry.sql.includes('ROW_NUMBER()')).length, 1);
  assert.ok(rows.every(row => !('_doc_rank' in row)));
});

test('기존 v3 청크는 규칙 변경으로 자동 재분할되며 문서 공백과 seq를 보존한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const source = '가'.repeat(800) + '\n'.repeat(200) + '가'.repeat(300);
  await conn.query('INSERT INTO knowledge (title, content) VALUES (?, ?)', ['기존 문서', source]);
  const [doc] = await conn.query("SELECT MD5(JSON_ARRAY('chunk:900:1000:150:v3', title, content)) h FROM knowledge");
  for (const [i, content] of ['가'.repeat(800), '가'.repeat(300)].entries()) {
    await conn.query('INSERT INTO knowledge_chunk (doc_seq, chunk_no, chunk_of, doc_hash, title, content) VALUES (1, ?, 2, ?, ?, ?)',
      [i + 1, doc.h, '기존 문서', content]);
  }
  const result = await syncEmbeddings();
  assert.equal(result.chunks, 2);
  assert.equal(result.embedded, 2);
  const rows = await loadChunkRanges([{ doc_seq: 1, from: 1, to: 2 }]);
  assert.deepEqual(rows.map(r => r.seq), [1, 2]);
  const [item] = buildItems([{ doc_seq: 1, rep: 1, from: 1, to: 2, dist: 0.1 }], rows);
  assert.equal(item.content, source);
  assert.equal((await syncEmbeddings()).embedded, 0);
  assert.equal((await syncEmbeddings()).chunks, 0);
});

test('벡터 배치 저장 실패는 정상 행만 재저장하고 실패 행은 다음 동기화에서 복구한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO qa_method (title, method) VALUES ('행1','본문'), ('행2','본문'), ('행3','본문')");
  await conn.query(`CREATE TRIGGER reject_vector BEFORE INSERT ON vec_qa_method FOR EACH ROW
    BEGIN IF NEW.seq = 2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture storage failure'; END IF; END`);
  const partial = await syncEmbeddings();
  assert.equal(partial.embedded, 2);
  assert.equal(partial.failed, 1);
  assert.deepEqual((await conn.query('SELECT seq FROM vec_qa_method ORDER BY seq')).map(r => r.seq), [1, 3]);
  await conn.query('DROP TRIGGER reject_vector');
  const recovered = await syncEmbeddings();
  assert.equal(recovered.embedded, 1);
  assert.equal(recovered.failed, 0);
});

test('동기화 락 점유와 DB 오류 뒤에도 다음 회차가 정상 실행된다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("SELECT GET_LOCK('space_voc_embed_sync', 0)");
  try { assert.equal((await syncEmbeddings()).skipped, SKIP.BUSY); }
  finally { await conn.query("SELECT RELEASE_LOCK('space_voc_embed_sync')"); }
  await conn.query('DROP TABLE vec_qa_method');
  await assert.rejects(syncEmbeddings());
  assert.equal(Number((await conn.query("SELECT IS_FREE_LOCK('space_voc_embed_sync') AS free"))[0].free), 1);
  await conn.query(await sqlFile('schema.sql'));
  assert.equal((await syncEmbeddings()).skipped, SKIP.NONE);
});

test('청크 일부가 누락되어도 원문을 수정하지 않고 다음 동기화에서 복원한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const content = '첫 문단입니다. '.repeat(160) + '마지막 문단입니다. '.repeat(160);
  await conn.query('INSERT INTO knowledge (title, content) VALUES (?, ?)', ['청크 복구', content]);
  await syncEmbeddings();
  const original = await loadChunkRanges([{ doc_seq: 1, from: 1, to: 100 }]);
  assert.ok(original.length >= 3);
  const preserved = original[0].seq;
  await conn.query('DELETE FROM knowledge_chunk WHERE doc_seq = 1 AND chunk_no = 2');
  const repaired = await syncEmbeddings();
  const current = await loadChunkRanges([{ doc_seq: 1, from: 1, to: 100 }]);
  assert.equal(current.length, original.length, '같은 doc_hash의 다른 청크가 남아 있어도 누락을 복원해야 한다');
  assert.deepEqual(current.map(r => r.content), original.map(r => r.content));
  assert.equal(current[0].seq, preserved, '정상 청크의 ID는 보존한다');
  assert.equal(repaired.embedded, 1, '누락되어 재생성한 청크만 임베딩한다');
  assert.equal((await syncEmbeddings()).chunks, 0);
});

test('DB에 등록 가능한 보충 평면 문자가 포함된 쿼리명도 임베딩 없이 정확 검색한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const name = '📊'.repeat(60);
  await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, 'SELECT 1 FROM dual', 'DB')", [name]);
  const saved = process.env.EMBEDDING_URL;
  delete process.env.EMBEDDING_URL;
  try {
    const rows = await searchQueries(name);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].query_name, name);
    assert.equal(rows[0].exact, true);
  } finally { process.env.EMBEDDING_URL = saved; }
});

test('벡터 후보가 충분해도 정확 쿼리명은 해당 명세 한 건만 반환하고 임베딩 장애와 무관하다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  const name = 'daily_count';
  const sql = 'SELECT :day AS DAY FROM dual';
  await conn.query(`INSERT INTO query_registry
    (query_name, query_desc, query_sql, input_desc, output_desc, target_db_name)
    VALUES (?, '일별 처리량', ?, 'day: YYYYMMDD', 'DAY: 조회 기준일', 'DB')`, [name, sql]);
  for (let i = 1; i <= 3; i++) {
    await conn.query(`INSERT INTO query_registry (query_name, query_desc, query_sql, target_db_name)
      VALUES (?, '다른 처리량 조회', 'SELECT 1 FROM dual', 'DB')`, [`daily_count_other_${i}`]);
  }
  assert.equal((await syncEmbeddings()).failed, 0);
  assert.ok((await searchQueries('일별 처리량 의미 검색')).length >= 3, '보충할 벡터 후보가 실제로 있어야 한다');

  const savedUrl = process.env.EMBEDDING_URL;
  const savedMode = embedMode;
  try {
    for (const mode of ['ok', 'down', 'unconfigured']) {
      embedMode = mode;
      if (mode === 'unconfigured') delete process.env.EMBEDDING_URL;
      else process.env.EMBEDDING_URL = savedUrl;
      const before = embedCalls;
      searchStatements = [];
      registryStatements = [];
      const rows = await searchQueries(' \tDAILY_COUNT\n');
      assert.equal(rows.length, 1, `${mode}: 정확 이름 결과에 벡터 후보를 덧붙이지 않는다`);
      assert.equal(rows[0].query_name, name);
      assert.equal(rows[0].query_sql, sql);
      assert.equal(rows[0].input_desc, 'day: YYYYMMDD');
      assert.equal(rows[0].output_desc, 'DAY: 조회 기준일');
      assert.equal(rows[0].target_db_name, 'DB');
      assert.equal(rows[0].exact, true);
      assert.equal(embedCalls, before, `${mode}: 정확 조회에서 임베딩 서버를 호출했다`);
      assert.equal(searchStatements.length, 0, `${mode}: 정확 조회에서 벡터 SQL을 실행했다`);
      assert.equal(registryStatements.length, 1, `${mode}: UNIQUE 인덱스 조회 한 번으로 끝나야 한다`);
    }
  } finally {
    if (savedUrl === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = savedUrl;
    embedMode = savedMode;
  }
});

test('처리방법 벡터 검색은 한글 조사·짧은 이름·리터럴 기호를 해석하여 본문 순서대로 쿼리를 싣는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  // 등록 순서와 절차 순서를 반대로 둔다. '_'가 와일드카드가 되면 batch_job도 잘못 선택된다.
  for (const name of ['미등장', 'batch_job', 'batchXjob', 'Q', '배치상태조회']) {
    await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, 'SELECT 1 FROM dual', 'DB')", [name]);
  }
  const title = '라우팅 순서 검증';
  const method = '배치상태조회를 실행하고 q를 확인한 뒤 batchXjob으로 마무리한다.';
  await conn.query('INSERT INTO qa_method (title, method) VALUES (?, ?)', [title, method]);
  await syncEmbeddings();
  let snapshot;
  const result = await handleQuestion(title, [], { deps: { decide: async ctx => {
    if (!ctx.history.length) return { action: 'search', text: `${title}\n${method}`, targets: ['qa_method'] };
    snapshot = ctx;
    return { action: 'answer', answer: '절차 확인 완료' };
  } } });
  assert.deepEqual(snapshot.queries.map(q => q.query_name), ['배치상태조회', 'Q', 'batchXjob']);
  assert.ok(snapshot.queries.every(q => q.detail));
  assert.equal(result.trace[0].hits.qaMethods, 1);
  assert.equal(result.trace[0].hits.queries, 3);
  assert.equal(result.search.searchFailed, undefined);
});

test('DB collation이 같게 취급하는 다른 이름을 정확 쿼리명으로 반환하지 않는다', async t => {
  for (const [registered, requested] of [['📊조회', '📈조회'], ['résumé', 'resume']]) {
    await t.test(`${registered}와 ${requested}`, async () => {
      await conn.query(await sqlFile('schema.sql'));
      await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, 'SELECT 1 FROM dual', 'DB')", [registered]);
      assert.deepEqual(await loadQueriesByNames([requested]), []);
      assert.equal((await loadQueriesByNames([registered.toUpperCase()]))[0].query_name, registered);
      assert.deepEqual(await loadQueriesMentionedIn(`${requested}를 실행한다`.toLowerCase()), [],
        '처리방법 라우팅도 다른 식별자를 선택하면 안 된다');
      assert.equal((await loadQueriesMentionedIn(`${registered}를 실행한다`.toLowerCase()))[0].query_name, registered);
      const saved = process.env.EMBEDDING_URL;
      delete process.env.EMBEDDING_URL;
      try {
        assert.equal(await searchQueries(requested), null, '정확 일치가 아니므로 임베딩 없는 구성에서는 검색 불가다');
      } finally { process.env.EMBEDDING_URL = saved; }
    });
  }
});

test('미등록 쿼리명의 DB collation 충돌로 다른 등록 쿼리를 실행하지 않는다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES ('📊조회', 'SELECT 1 FROM dual', 'DB')");
  const decisions = [
    { action: 'run_query', query_name: '📈조회', params: {} },
    { action: 'answer', answer: '완료' },
  ];
  let runs = 0;
  const result = await handleQuestion('쿼리 식별자 확인', [], { deps: {
    decide: async () => decisions.shift(),
    run: async () => { runs++; return { rows: [], targetDb: 'DB' }; },
  } });
  assert.equal(runs, 0, '요청하지 않은 등록 쿼리가 실행되면 안 된다');
  assert.ok(result.trace[0].error);
});

test('Unicode 대소문자 변환이 있는 쿼리명도 정확 검색과 처리방법 라우팅에서 일치한다', async t => {
  for (const name of ['𐐀조회', 'ΟΣ', 'İ조회', 'İ'.repeat(60), 'K조회']) {
    await t.test(name, async () => {
      await conn.query(await sqlFile('schema.sql'));
      await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, 'SELECT 1 FROM dual', 'DB')", [name]);
      assert.deepEqual((await loadQueriesByNames([name.toLowerCase()])).map(q => q.query_name), [name]);
      assert.deepEqual((await loadQueriesMentionedIn(`${name}를 실행한다`.toLowerCase())).map(q => q.query_name), [name]);
      const saved = process.env.EMBEDDING_URL;
      delete process.env.EMBEDDING_URL;
      try {
        assert.equal((await searchQueries(name.toLowerCase()))?.[0]?.query_name, name);
      } finally { process.env.EMBEDDING_URL = saved; }
    });
  }
});

test('Unicode 이름은 본문 주변 글자와 무관하게 실제 검색에서 Mock 실행까지 연결된다', async t => {
  await conn.query(await sqlFile('schema.sql'));
  const names = ['Σ', 'ΟΣ', 'İΣ'];
  for (const name of names) {
    await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES (?, 'SELECT 1 FROM dual', 'DB')", [name]);
  }
  const method = 'AΣ를 실행하고 ΟΣA를 실행한 뒤 İΣA를 실행한다';
  await conn.query('INSERT INTO qa_method (title, method) VALUES (?, ?)', ['Unicode 절차', method]);
  assert.equal((await syncEmbeddings()).failed, 0);
  assert.deepEqual((await loadQueriesMentionedIn(method)).map(row => row.query_name), names);
  const saved = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'mock';
  t.after(() => { if (saved === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = saved; });
  const executed = [];
  const result = await handleQuestion('Unicode 절차', [], { deps: {
    decide: ctx => ctx.history.length
      ? llm.decide(ctx)
      : { action: 'search', text: `Unicode 절차\n${method}`, targets: ['qa_method'] },
    run: async row => {
      executed.push(row.query_name);
      return { rows: [{ VALUE: executed.length }], totalRows: 1, capped: false, targetDb: 'DB' };
    },
  } });
  assert.equal(result.trace[0].hits.queries, 3, 'agent가 본문을 먼저 소문자화해 라우팅을 망가뜨리면 안 된다');
  assert.deepEqual(executed, names, 'Mock의 실행 계획도 실제 라우팅과 같은 이름 판정을 사용한다');
});

test('등록 1000건의 라우팅은 이름 인덱스와 상위 30건 상세 조회 두 번으로 끝난다', async t => {
  await conn.query(await sqlFile('schema.sql'));
  const names = Array.from({ length: 1000 }, (_, i) => `route_${String(i).padStart(4, '0')}`);
  await conn.batch("INSERT INTO query_registry (query_name, query_desc, query_sql, target_db_name) VALUES (?, ?, 'SELECT 1 FROM dual', 'DB')",
    names.map(name => [name, '설명'.repeat(1000)]));
  const plan = await conn.query('EXPLAIN SELECT seq, query_name FROM query_registry');
  assert.equal(plan[0].key, 'query_name');
  assert.match(plan[0].Extra, /Using index/, '긴 설명과 SQL 대신 이름 인덱스만 읽는다');
  registryStatements = [];
  const text = [...names].reverse().join(' ');
  const start = performance.now();
  const rows = await loadQueriesMentionedIn(text, 30);
  t.diagnostic(`1000개 이름 대조와 30개 상세 조회: ${(performance.now() - start).toFixed(1)}ms`);
  assert.deepEqual(rows.map(q => q.query_name), [...names].reverse().slice(0, 30));
  assert.equal(registryStatements.length, 2);
  assert.equal(registryStatements[0].sql, 'SELECT seq, query_name FROM query_registry');
  assert.equal(registryStatements[1].args[0].length, 30);
});

test('루틴 마이그레이션은 기존 쿼리를 보존하며 반복 적용·관리자 CRUD를 지원한다', async () => {
  await conn.query(await sqlFile('schema.sql'));
  await conn.query('ALTER TABLE query_registry DROP COLUMN bind_config, DROP COLUMN query_type');
  await conn.query("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES ('legacy', 'SELECT 1 FROM dual', 'OPS')");
  await conn.query(await sqlFile('migrate-routines.sql'));
  await conn.query(await sqlFile('migrate-routines.sql'));
  const [legacy] = await conn.query("SELECT * FROM query_registry WHERE query_name='legacy'");
  assert.equal(legacy.query_type, 'QUERY');
  assert.equal(legacy.bind_config, null);
  assert.equal(legacy.query_sql, 'SELECT 1 FROM dual');
  await conn.query("INSERT INTO target_db (db_name, connection_info, db_user, db_password) VALUES ('OPS', 'unused', 'reader', 'unused')");
  const store = createAdminStore();
  const saved = await store.save('queries', { query_name: 'routine', query_type: 'FUNCTION',
    query_sql: 'BEGIN :result := app.total(:id); END;', target_db_name: 'OPS',
    bind_config: '{"id":{"dir":"IN","type":"NUMBER"},"result":{"dir":"OUT","type":"NUMBER"}}' });
  assert.equal(saved.query_type, 'FUNCTION');
  assert.equal(JSON.parse(saved.bind_config).result.dir, 'OUT');
  assert.equal((await store.list('queries', { q: 'FUNCTION' })).items[0].query_type, 'FUNCTION');
  const edited = await store.save('queries', { ...saved, query_desc: '수정' }, saved.seq, saved.revision);
  assert.equal(edited.query_type, 'FUNCTION');
  await store.remove('queries', edited.seq, edited.revision);
});
