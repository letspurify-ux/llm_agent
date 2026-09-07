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
import { closePool, loadChunkRanges, insertChatLog } from '../../src/db.js';
import { syncEmbeddings, syncSummary, SKIP } from '../../src/embed-sync.js';
import { handleQuestion } from '../../src/agent.js';
import { buildItems } from '../../src/chunk.js';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sqlFile = name => readFile(new URL(`../../sql/${name}`, import.meta.url), 'utf8');
let dir, server, conn;
let embeddedTexts = [];
// 임베딩 서버의 응답 모양. 'ok' 외의 값은 아래 실패 갈래 테스트가 try/finally로 되돌린다 —
// 이 대역이 모든 테스트에 공유되므로 되돌리지 않으면 뒤 테스트가 남의 고장을 물려받는다.
let embedMode = 'ok';
let embedCalls = 0;
// 대역이 만드는 벡터의 one-hot 위치 — 텍스트만으로 정해진다. 응답 순서가 뒤바뀌어도 어느 행의
// 벡터인지 이 값으로 되짚을 수 있다 (embedding.js가 index로 짝짓는 것을 검증하는 근거).
const slotOf = text => createHash('sha256').update(text).digest().readUInt16BE(0) % 1024;

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
    embedCalls++;
    // 5xx는 서버 사정(재시도 가치 있음), 400은 이 입력의 거부(재시도해도 같다) — embedding.js가 그 둘을 가른다.
    if (embedMode === 'down') return new Response('{"error":"boom"}', { status: 503 });
    if (embedMode.startsWith('reject:') && input.some(text => text.includes(embedMode.slice(7)))) {
      return new Response('{"error":"rejected"}', { status: 400 });
    }
    embeddedTexts.push(...input);
    const data = input.map((text, index) =>
      ({ index, embedding: Array.from({ length: 1024 }, (_, i) => Number(i === slotOf(text))) }));
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
