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
import { closePool, loadChunkRanges } from '../../src/db.js';
import { syncEmbeddings } from '../../src/embed-sync.js';
import { handleQuestion } from '../../src/agent.js';
import { buildItems } from '../../src/chunk.js';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sqlFile = name => readFile(new URL(`../../sql/${name}`, import.meta.url), 'utf8');
let dir, server, conn;
let embeddedTexts = [];

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
  mock.method(mariadb, 'createPool', options => createPool({
    ...options, socketPath, user: 'root', password: '', database: 'llm_agent',
  }));
  process.env.EMBEDDING_URL = 'http://test.invalid/v1';
  process.env.ORACLE_MOCK = '1';
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const { input } = JSON.parse(init.body);
    embeddedTexts.push(...input);
    return new Response(JSON.stringify({ data: input.map((text, index) => {
      const slot = createHash('sha256').update(text).digest().readUInt16BE(0) % 1024;
      return { index, embedding: Array.from({ length: 1024 }, (_, i) => Number(i === slot)) };
    }) }));
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
  await conn.query("UPDATE knowledge SET content = '갱신된 원문' WHERE seq = 1");
  await syncEmbeddings();
  assert.equal((await conn.query('SELECT content FROM knowledge_chunk WHERE doc_seq = 1'))[0].content, '갱신된 원문');
  assert.ok(embeddedTexts.some(text => text.includes('갱신된 원문')));
  await conn.query('DELETE FROM knowledge WHERE seq = 1');
  await syncEmbeddings();
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM knowledge_chunk WHERE doc_seq = 1'))[0].n), 0);
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM vec_knowledge_chunk v LEFT JOIN knowledge_chunk c USING(seq) WHERE c.seq IS NULL'))[0].n), 0);
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

test('동기화 CLI는 부분 저장 실패·청크 실패·DB 오류를 실패 코드로 알리고 풀을 닫는다', async t => {
  for (const mode of ['vector', 'chunk', 'db']) {
    await t.test(mode, async () => {
      await conn.query(await sqlFile('schema.sql'));
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
      assert.equal(result.code, 1, `실패를 종료 코드로 알려야 한다: ${mode}`);
      assert.match(result.stdout, /\[test\] pool closed/, '실패 경로도 커넥션 풀을 닫아야 한다');
    });
  }
});
