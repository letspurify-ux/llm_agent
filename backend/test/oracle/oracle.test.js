import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import mariadb from 'mariadb';
import oracledb from 'oracledb';
import { runQuery, closeOraclePools } from '../../src/oracle.js';
import { closePool } from '../../src/db.js';
import { bindNames, assertReadOnly } from '../../src/sql.js';
import { MAX_ROWS, MAX_CELL_LEN, TRUNC_MARK } from '../../src/constants.js';
import { openaiDecide, buildPrompt } from '../../src/llm-openai.js';
import { sanitizeDecision } from '../../src/llm.js';
import { readStoredResult } from '../../src/read-result.js';

const exec = promisify(execFile);
const container = `backend-oracle-test-${randomUUID().slice(0, 8)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let created = false, owner, reader;

before(async () => {
  const image = process.env.ORACLE_TEST_IMAGE || 'gvenzl/oracle-free:latest';
  // 이미 설치된 이미지만 쓴다. 테스트가 대형 이미지를 자동 다운로드하지 않는다.
  await exec('docker', ['image', 'inspect', image]);
  await exec('docker', ['run', '--rm', '-d', '--name', container,
    '-p', '127.0.0.1::1521', '-e', 'ORACLE_RANDOM_PASSWORD=yes', image]);
  created = true;
  let ready = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { await exec('docker', ['exec', container, 'healthcheck.sh'], { timeout: 5000 }); ready = true; break; }
    catch { await sleep(500); }
  }
  assert.ok(ready, '임시 Oracle DB 기동 시간 초과');
  const sql = 'WHENEVER SQLERROR EXIT FAILURE\nALTER SESSION SET CONTAINER = FREEPDB1;\n'
    + await readFile(new URL('../../sql/oracle-init.sql', import.meta.url), 'utf8');
  const init = spawn('docker', ['exec', '-i', '-e', 'NLS_LANG=.AL32UTF8', container, 'sqlplus', '-s', '/', 'as', 'sysdba']);
  let output = '';
  init.stdout.on('data', data => { output += data; });
  init.stderr.on('data', data => { output += data; });
  init.stdin.end(sql);
  const [code] = await once(init, 'close');
  assert.equal(code, 0, output);
  const { stdout } = await exec('docker', ['port', container, '1521/tcp']);
  const connectString = `${stdout.trim()}/FREEPDB1`;
  owner = await oracledb.getConnection({ user: 'APP_USER', password: 'app_user_1234', connectString });
  reader = await oracledb.getConnection({ user: 'VOC_READER', password: 'voc_reader_1234', connectString });
  owner.callTimeout = 5000; reader.callTimeout = 5000;
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({
      query: async sql => {
        assert.match(sql, /FROM target_db/);
        return [{ db_name: 'DISPOSABLE_ORACLE', db_type: 'oracle', connection_info: connectString,
          db_user: 'VOC_READER', db_password: 'voc_reader_1234' }];
      }, release: async () => {},
    }), end: async () => {},
  }));
}, { timeout: 120_000 });

after(async () => {
  try {
    await closeOraclePools(); await closePool();
    await owner?.close(); await reader?.close();
  } finally {
    mock.restoreAll();
    if (created) await exec('docker', ['rm', '-f', container], { timeout: 30_000 });
  }
});

const registry = query_sql => ({ query_name: 'fixture', query_sql, target_db_name: 'DISPOSABLE_ORACLE' });

test('실제 Oracle의 128자 컬럼·바인드를 프롬프트와 결과 추가 읽기까지 보존한다', async () => {
  const names = ['A', 'B'].map(last => 'P'.repeat(127) + last);
  const params = { [names[0]]: 'first', [names[1]]: 'second' };
  const cols = names.map(name => `:${name} AS "${name}"`);
  const filler = Array.from({ length: 20 }, (_, i) => `RPAD('x', 200, 'x') AS C${i}`);
  const result = await runQuery(registry(`SELECT ${[...cols, ...filler].join(', ')} FROM DUAL`), params);
  const prompt = buildPrompt({ question: '상세 조회', chat: [], knowledge: [], qaMethods: [], queries: [],
    history: [{ query_name: 'fixture', params, ...result }] });
  const shown = JSON.parse(/결과 1건[^\n]*: (\[[^\n]*\])/.exec(prompt)[1])[0];
  assert.equal(shown[names[0]], 'first');
  assert.equal(shown[names[1]], 'second');
  assert.deepEqual(JSON.parse(/params=(\{[^\n]*\}) →/.exec(prompt)[1]), params);
  assert.deepEqual(readStoredResult(result.rows, { step: 1, cols: names }).rows, [params]);
});

test('LLM이 숫자로 준 17자리 ID로 실제 Oracle의 정확한 행을 조회한다', async t => {
  const query = registry(`WITH ids AS (
    SELECT 12345678901234567 AS id, 'exact' AS label FROM DUAL UNION ALL
    SELECT 12345678901234568 AS id, 'rounded' AS label FROM DUAL
  ) SELECT label FROM ids WHERE id = :id`);
  const content = '{"action":"run_query","query_name":"fixture","params":{"id":12345678901234567}}';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })));
  const decision = sanitizeDecision(await openaiDecide({ question: '12345678901234567 조회',
    chat: [], knowledge: [], qaMethods: [], queries: [query], history: [] }));
  const result = await runQuery(query, decision.params);
  assert.deepEqual(result.rows, [{ LABEL: 'exact' }]);
});

test('실제 Oracle에서 바인드·날짜 왕복·큰 숫자·셀 절단이 동작한다', async () => {
  const jobs = registry('SELECT JOB_ID, LAST_RUN_AT FROM BATCH_JOBS WHERE JOB_ID = :job_id');
  const first = await runQuery(jobs, { JOB_ID: 'BATCH001' });
  assert.deepEqual(first.rows, [{ JOB_ID: 'BATCH001', LAST_RUN_AT: '2026-08-28 01:00:00' }]);
  const again = await runQuery(registry('SELECT JOB_ID FROM BATCH_JOBS WHERE LAST_RUN_AT = :at'), { at: first.rows[0].LAST_RUN_AT });
  assert.deepEqual(again.rows, [{ JOB_ID: 'BATCH001' }]);
  const values = await runQuery(registry("SELECT 12345678901234567 AS BIG_ID, RPAD('x', 300, 'x') AS BODY FROM DUAL"));
  assert.equal(values.rows[0].BIG_ID, '12345678901234567');
  assert.equal(values.rows[0].BODY, 'x'.repeat(MAX_CELL_LEN) + TRUNC_MARK);
});

test('실제 Oracle 결과의 행 상한과 초과 표시를 지킨다', async () => {
  const result = await runQuery(registry(`SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= ${MAX_ROWS + 2}`));
  assert.equal(result.rows.length, MAX_ROWS);
  assert.equal(result.totalRows, MAX_ROWS);
  assert.equal(result.capped, true);
});

test('주석 줄 끝 판정이 Oracle과 일치한다 — 단독 CR은 주석을 끝내지 않는다', async () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const prefix = `SELECT JOB_ID FROM BATCH_JOBS -- comment${newline}`;
    const actual = await owner.execute(`${prefix}WHERE JOB_ID = 'BATCH001'`);
    assert.equal(actual.rows.length, newline === '\r' ? 3 : 1);
    assert.deepEqual(bindNames(`${prefix}WHERE JOB_ID = :job_id`), newline === '\r' ? [] : ['job_id']);
    if (newline === '\r') assert.doesNotThrow(() => assertReadOnly(`${prefix}FOR UPDATE`));
    else assert.throws(() => assertReadOnly(`${prefix}FOR UPDATE`), /FOR UPDATE/);
  }
});

test('조회 가드와 실제 READ 계정이 행 잠금·쓰기를 차단한다', async () => {
  for (const sql of ['SELECT JOB_ID FROM BATCH_JOBS FOR UPDATE', 'DELETE FROM BATCH_JOBS']) {
    await assert.rejects(runQuery(registry(sql)), error => error.safe === true);
    await assert.rejects(reader.execute(sql), error =>
      /ORA-(?:01031: insufficient privileges|419\d{2}: missing (?:SELECT|DELETE) privilege)/.test(error.message));
  }
});
