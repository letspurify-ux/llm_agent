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
import { resolveTableData, resolveChartData } from '../../src/chart.js';
import { parseChartBlock } from '../../../frontend/src/chart.js';
import { handleQuestion } from '../../src/agent.js';

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

test('실제 Oracle의 말줄임표 컬럼 값은 보관·프롬프트·추가 읽기·표·차트에서 보존된다', async () => {
  for (const count of [29, 39]) {
    const columns = Array.from({ length: count }, (_, i) => `RPAD('x', 200, 'x') AS C${i}`);
    const result = await runQuery(registry(`SELECT 42 AS "…", ${columns.join(', ')} FROM DUAL`));
    assert.equal(result.rows[0]['…'], 42);
    const view = readStoredResult(result.rows, { step: 1, cols: Object.keys(result.rows[0]).filter(k => k !== 'C0') });
    const prompt = buildPrompt({ question: '생략 안내와 실제 값', chat: [], knowledge: [], qaMethods: [], queries: [],
      history: [{ query_name: 'fixture', totalRows: 1, ...view }] });
    const [shown] = JSON.parse(/: (\[[^\n]*\])/.exec(prompt)[1]);
    assert.equal(shown['…'], 42);
    const notes = Object.entries(shown).filter(([k]) => k !== '…').map(([, v]) => v).join(' ');
    assert.match(notes, /프롬프트 길이 제한/);
    if (count > 30) assert.match(notes, /컬럼 수 상한 30개/);
    assert.match(resolveTableData('```table\nstep: 1\ncols: …\n```', [result.rows]), /\| 42 \|/);
    const chart = resolveChartData('```chart\ntype: bar\nx: C0\ny: …\ndata: step 1\n```', [result.rows]);
    const parsed = parseChartBlock(chart.split('\n').slice(1, -1).join('\n'));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.spec.rows[0].values, [42]);
  }
});

test('프롬프트가 자른 실행 파라미터를 복사한 실제 Oracle 재조회는 0건으로 실행되지 않는다', async () => {
  const original = 'x'.repeat(350);
  const q = { ...registry("SELECT 1 AS ID FROM DUAL WHERE :memo = RPAD('x', 350, 'x')"), seq: 1 };
  assert.deepEqual((await runQuery(q, { memo: original })).rows, [{ ID: 1 }]);
  let copied, turn = 0;
  const result = await handleQuestion(original, [], { deps: {
    search: async () => ({ queries: [q] }),
    run: runQuery,
    decide: async c => {
      switch (turn++) {
        case 0: return { action: 'search', text: '메모', targets: ['query'] };
        case 1: return sanitizeDecision({ action: 'run_query', query_name: q.query_name, params: { memo: original } });
        case 2: {
          const shown = JSON.parse(/params=(\{[^\n]*\}) →/.exec(buildPrompt(c))[1]);
          copied = shown.memo.replace(/…\(생략\)$/, '');
          return sanitizeDecision({ action: 'run_query', query_name: q.query_name, params: { memo: copied } });
        }
        default: return { action: 'answer', answer: '원본 값 확인 필요' };
      }
    },
  } });
  assert.ok(copied.length < original.length);
  assert.match(result.trace[2].error ?? '', /잘린 값이라 원본과 다름/);
  assert.equal(result.trace[2].rows, undefined, '잘린 파라미터로 조회한 0건이 결과로 남았다');
  // 원본은 여전히 적법하며, 요청별 절단 가드가 다른 요청까지 오염시키지 않는다.
  assert.deepEqual((await runQuery(q, { memo: original })).rows, [{ ID: 1 }]);
});

test('숫자·문자열 바인드로 다른 행을 찾는 실제 Oracle 조회를 중복으로 생략하지 않는다', async () => {
  const q = { ...registry(`WITH codes AS (
    SELECT CAST('01' AS VARCHAR2(2)) AS code FROM DUAL
    UNION ALL SELECT CAST('1' AS VARCHAR2(2)) FROM DUAL
  ) SELECT code FROM codes WHERE code = :id ORDER BY code`), seq: 1 };
  const numeric = await runQuery(q, { id: 1 });
  const textual = await runQuery(q, { id: '1' });
  assert.deepEqual(numeric.rows, [{ CODE: '01' }, { CODE: '1' }]);
  assert.deepEqual(textual.rows, [{ CODE: '1' }]);

  for (const batch of [false, true]) {
    const queries = [{ query_name: q.query_name, params: { id: 1 } },
      { query_name: q.query_name, params: { id: '1' } }];
    const decisions = [
      { action: 'search', text: '코드 조회', targets: ['query'] },
      ...(batch ? [{ action: 'run_queries', queries }]
        : queries.map(item => ({ action: 'run_query', ...item }))),
      { action: 'answer', answer: '조회 완료' },
    ];
    const result = await handleQuestion('숫자 비교 후 정확한 문자열로 다시 조회', [], { deps: {
      decide: async () => sanitizeDecision(decisions.shift()),
      search: async () => ({ queries: [{ ...q }] }),
      run: runQuery,
    } });
    assert.deepEqual(result.trace.filter(h => h.rows).map(h => h.rows), [numeric.rows, textual.rows],
      `${batch ? '배치' : '순차'} 조회에서 타입이 다른 두 번째 바인드가 사라졌다`);
  }
});

test('TIMESTAMP의 밀리초는 결과·프롬프트·추가 읽기·후속 바인드에서 보존된다', async () => {
  const events = `WITH events AS (
    SELECT 1 AS id, TIMESTAMP '2026-09-06 12:34:56.123' AS ts,
      TO_TIMESTAMP_TZ('2026-09-06 12:34:56.123 +09:00', 'YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM') AS tz FROM DUAL
    UNION ALL SELECT 2, TIMESTAMP '2026-09-06 12:34:56.456',
      TO_TIMESTAMP_TZ('2026-09-06 12:34:56.456 +09:00', 'YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM') FROM DUAL
  )`;
  const result = await runQuery(registry(`${events} SELECT id, ts, tz,
    CAST(tz AS TIMESTAMP WITH LOCAL TIME ZONE) AS ltz FROM events ORDER BY id`));
  const chart = resolveChartData('```chart\ntype: line\nx: TS\ny: ID\ndata: step 1\n```', [result.rows]);
  const parsed = parseChartBlock(chart.split('\n').slice(1, -1).join('\n'));
  assert.equal(parsed.ok, true, '소수 초가 다른 조회 행이 중복 x로 처리됐다');
  assert.equal(parsed.spec.rows[1].x - parsed.spec.rows[0].x, 333);
  for (const col of ['TS', 'TZ', 'LTZ']) {
    assert.notEqual(result.rows[0][col], result.rows[1][col], `${col}: 서로 다른 시각이 같은 값이 됐다`);
    assert.match(result.rows[0][col], /56\.123(?: |$)/);
    assert.match(result.rows[1][col], /56\.456(?: |$)/);
    const view = readStoredResult(result.rows, { step: 1, cols: [col], offset: 1, limit: 1 });
    const prompt = buildPrompt({ question: '둘째 시각 조회', chat: [], knowledge: [], qaMethods: [], queries: [],
      history: [{ query_name: 'fixture', ...result, ...view }] });
    assert.ok(prompt.includes(result.rows[1][col]), '후속 조회에 필요한 시각이 프롬프트에서 달라졌다');
    const expr = col === 'LTZ' ? 'CAST(tz AS TIMESTAMP WITH LOCAL TIME ZONE)' : col;
    // LTZ의 문자열 암묵 변환은 시간대 없는 NLS_TIMESTAMP_FORMAT을 쓴다.
    // 오프셋이 포함된 조회 값을 되돌리는 등록 SQL은 그 시각을 명시적으로 해석해야 한다.
    const bind = col === 'LTZ' ? "TO_TIMESTAMP_TZ(:at, 'YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM')" : ':at';
    const again = await runQuery(registry(`${events} SELECT id FROM events WHERE ${expr} = ${bind}`), { at: view.rows[0][col] });
    assert.deepEqual(again.rows, [{ ID: 2 }], `${col}: 선택한 시각으로 정확한 행을 다시 찾지 못했다`);
  }
  // Date의 해상도보다 세밀한 값은 등록 SQL에서 문자열로 반환해야 한다.
  const precise = await runQuery(registry("SELECT TO_CHAR(TIMESTAMP '2026-09-06 12:34:56.123456789', 'YYYY-MM-DD HH24:MI:SS.FF9') AS TS FROM DUAL"));
  assert.equal(precise.rows[0].TS, '2026-09-06 12:34:56.123456789');
  const exact = await runQuery(registry("SELECT 1 AS OK FROM DUAL WHERE TIMESTAMP '2026-09-06 12:34:56.123456789' = TO_TIMESTAMP(:at, 'YYYY-MM-DD HH24:MI:SS.FF9')"), { at: precise.rows[0].TS });
  assert.deepEqual(exact.rows, [{ OK: 1 }]);
});

test('실제 Oracle의 대소문자가 다른 컬럼은 표·차트에서도 서로 다른 값이다', async () => {
  const result = await runQuery(registry(`SELECT 'A' AS LABEL, 10 AS "amount", 100 AS "AMOUNT" FROM DUAL`));
  assert.deepEqual(result.rows, [{ LABEL: 'A', amount: 10, AMOUNT: 100 }]);
  const table = resolveTableData('```table\nstep: 1\ncols: amount, AMOUNT\n```', [result.rows]);
  assert.ok(table.includes('| amount | AMOUNT |\n| --- | --- |\n| 10 | 100 |'), table);
  const chart = resolveChartData('```chart\ntype: bar\nx: LABEL\ny: amount\ny2: AMOUNT\ndata: step 1\n```', [result.rows]);
  const parsed = parseChartBlock(chart.split('\n').slice(1, -1).join('\n'));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.spec.series, [{ name: 'amount', axis: 'left' }, { name: 'AMOUNT', axis: 'right' }]);
  assert.deepEqual(parsed.spec.rows[0].values, [10, 100]);
});

test('실제 Oracle BINARY_FLOAT·BINARY_DOUBLE 특수 값과 NULL을 구분한다', async () => {
  const result = await runQuery(registry(`SELECT BINARY_DOUBLE_INFINITY AS POS,
    -BINARY_FLOAT_INFINITY AS NEG, BINARY_DOUBLE_NAN AS NAN, NULL AS EMPTY FROM DUAL`));
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows)), [
    { POS: 'Infinity', NEG: '-Infinity', NAN: 'NaN', EMPTY: null },
  ]);
});

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
