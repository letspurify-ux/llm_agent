import { test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import oracledb from 'oracledb';
import { runQuery, closeOraclePools } from '../src/oracle.js';
import { closePool } from '../src/db.js';
import { MAX_ROWS } from '../src/constants.js';

test('QUERY와 스칼라 루틴도 재사용 커넥션에서 매번 출력 버퍼를 초기화하고 정리한다', async t => {
  const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER };
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  let enabled = false;
  const buffer = ['previous request'];
  let prepared = 0, cleared = 0, released = 0;
  const conn = {
    execute: async (sql, binds, options) => {
      if (sql === 'SET TRANSACTION READ ONLY') return {};
      if (sql === 'BEGIN DBMS_OUTPUT.DISABLE; DBMS_OUTPUT.ENABLE(NULL); END;') {
        buffer.length = 0; enabled = true; prepared++; return {};
      }
      if (sql === 'BEGIN DBMS_OUTPUT.DISABLE; END;') {
        buffer.length = 0; enabled = false; cleared++; return {};
      }
      assert.equal(enabled, true);
      assert.deepEqual(buffer, [], '이전 실행의 출력이 섞였다');
      assert.equal(options.autoCommit, false);
      buffer.push('row 1', 'row 2', 'row 3');
      return sql.startsWith('SELECT')
        ? { rows: buffer.map(LINE => ({ LINE })) }
        : { outBinds: { count: String(buffer.length) } };
    },
    rollback: async () => {},
    close: async options => { assert.ok(!options?.drop); released++; },
  };
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({ query: async () => [{ db_name: 'OUTPUT', db_type: 'oracle',
      connection_info: 'unused', db_user: 'reader', db_password: 'unused' }], release: async () => {} }), end: async () => {},
  }));
  t.mock.method(oracledb, 'createPool', async () => ({ getConnection: async () => conn, close: async () => {} }));
  t.after(async () => {
    await closeOraclePools(); await closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const [query_type, query_sql] of [
    ['QUERY', 'SELECT LINE FROM TABLE(app.probe())'],
    ['PROCEDURE', 'BEGIN app.probe(:count); END;'],
    ['FUNCTION', 'BEGIN :count := app.probe(); END;'],
  ]) {
    const result = await runQuery({ query_name: 'probe', query_type, query_sql, target_db_name: 'OUTPUT',
      bind_config: query_type === 'QUERY' ? '' : '{"count":{"dir":"OUT","type":"NUMBER"}}' });
    assert.deepEqual(result.rows, query_type === 'QUERY'
      ? [{ LINE: 'row 1' }, { LINE: 'row 2' }, { LINE: 'row 3' }] : [{ count: 3 }]);
    assert.equal(enabled, false);
    assert.deepEqual(buffer, [], '커넥션 반납 전에 출력 버퍼를 비우지 않았다');
  }
  assert.equal(prepared, 3);
  assert.equal(cleared, 3);
  assert.equal(released, 3);
});

for (const queryType of ['PROCEDURE', 'FUNCTION']) for (const readOnly of [undefined, '0']) for (const mode of ['success', 'empty', 'fetch-error', 'abort', 'null-cursor', 'cursor-close-error', 'rollback-error', 'release-error', 'output-enable-error', 'output-clear-error', 'execute-error', 'all-errors']) {
  test(`${queryType} 커서 ${mode}, READ_ONLY=${readOnly ?? '기본값'}: 제한된 fetch와 커서 닫기·rollback·연결 반납`, async t => {
    const env = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_ROUTINE_READ_ONLY: process.env.ORACLE_ROUTINE_READ_ONLY };
    process.env.ORACLE_MOCK = '0';
    if (readOnly === undefined) delete process.env.ORACLE_ROUTINE_READ_ONLY;
    else process.env.ORACLE_ROUTINE_READ_ONLY = readOnly;
    const calls = [];
    let outputEnabled = false;
    const controller = new AbortController();
    const expectedRows = mode === 'empty' ? [] : [{ VALUE: 1 }, { VALUE: 2 }, { VALUE: 3 }];
    const cursor = {
      getRows: async count => {
        calls.push(['fetch', count]);
        assert.equal(outputEnabled, true, '커서가 DBMS_OUTPUT 버퍼를 읽기 전에 비활성화했다');
        if (mode === 'fetch-error' || mode === 'all-errors') throw new Error('fetch failed');
        if (mode === 'abort') controller.abort();
        return expectedRows;
      },
      close: async () => { calls.push(['cursor-close']); if (['cursor-close-error', 'all-errors'].includes(mode)) throw new Error('cursor close failed'); },
    };
    t.mock.method(mariadb, 'createPool', () => ({
      getConnection: async () => ({ query: async () => [{ db_name: 'ROUTINES', db_type: 'oracle',
        connection_info: 'unused', db_user: 'reader', db_password: 'unused' }], release: async () => {} }), end: async () => {},
    }));
    t.mock.method(oracledb, 'createPool', async () => ({
      getConnection: async () => ({
        execute: async (sql, binds, options) => {
          if (sql === 'BEGIN DBMS_OUTPUT.DISABLE; DBMS_OUTPUT.ENABLE(NULL); END;') {
            calls.push(['output-enable']);
            outputEnabled = true;
            if (mode === 'output-enable-error') throw new Error('output enable failed');
            return {};
          }
          if (sql === 'BEGIN DBMS_OUTPUT.DISABLE; END;') {
            calls.push(['output-clear']);
            if (['output-clear-error', 'all-errors'].includes(mode)) throw new Error('output clear failed');
            outputEnabled = false;
            return {};
          }
          calls.push(['execute', sql]);
          if (sql === 'SET TRANSACTION READ ONLY') return {};
          assert.equal(outputEnabled, true, '루틴을 호출하기 전에 버퍼를 활성화하지 않았다');
          assert.equal(options.autoCommit, false);
          assert.equal(binds.result.dir, oracledb.BIND_OUT);
          assert.equal(binds.result.type, oracledb.CURSOR);
          assert.equal(Object.hasOwn(binds.result, 'val'), false);
          if (mode === 'execute-error') throw new Error('execute failed');
          return { outBinds: { result: mode === 'null-cursor' ? null : cursor } };
        },
        rollback: async () => { calls.push(['rollback']); if (['rollback-error', 'all-errors'].includes(mode)) throw new Error('rollback failed'); },
        close: async options => {
          calls.push([options?.drop ? 'drop' : 'release']);
          if (mode === 'all-errors' || (mode === 'release-error' && !options?.drop)) throw new Error('release failed');
        },
      }), close: async () => {},
    }));
    t.after(async () => {
      await closeOraclePools(); await closePool();
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const sql = queryType === 'PROCEDURE' ? 'BEGIN app.orders(:result); END;' : 'BEGIN :result := app.orders(); END;';
    const task = runQuery({ query_name: 'routine', query_type: queryType, target_db_name: 'ROUTINES',
      query_sql: sql, bind_config: '{"result":{"dir":"OUT","type":"CURSOR"}}' },
    { result: 'ignore' }, undefined, null, controller.signal);
    if (mode === 'fetch-error' || mode === 'all-errors') await assert.rejects(task, /fetch failed/);
    else if (mode === 'output-enable-error') await assert.rejects(task, /output enable failed/);
    else if (mode === 'execute-error') await assert.rejects(task, /execute failed/);
    else if (mode === 'abort') await assert.rejects(task, { name: 'AbortError' });
    else if (mode === 'null-cursor') await assert.rejects(task, /유효한 REF CURSOR/);
    else assert.deepEqual(await task, { rows: expectedRows, totalRows: expectedRows.length, capped: false, targetDb: 'ROUTINES' });
    assert.deepEqual(calls.filter(c => c[0] === 'execute'), [
      ...(readOnly === '0' ? [] : [['execute', 'SET TRANSACTION READ ONLY']]),
      ...(mode === 'output-enable-error' ? [] : [['execute', sql]]),
    ]);
    assert.equal(calls.filter(c => c[0] === 'output-enable').length, 1);
    if (!['null-cursor', 'output-enable-error', 'execute-error'].includes(mode)) {
      assert.deepEqual(calls.find(c => c[0] === 'fetch'), ['fetch', MAX_ROWS + 1]);
      const dropped = ['cursor-close-error', 'rollback-error', 'output-clear-error', 'all-errors'].includes(mode);
      assert.deepEqual(calls.slice(mode === 'release-error' ? -5 : -4), [['cursor-close'], ['rollback'], ['output-clear'],
        ...(mode === 'release-error' ? [['release'], ['drop']] : [[dropped ? 'drop' : 'release']])]);
    } else assert.deepEqual(calls.slice(-3), [['rollback'], ['output-clear'], ['release']]);
  });
}

test('스칼라 NUMBER 출력은 조회 컬럼처럼 무손실일 때만 숫자가 되고, 범위 밖 NUMBER 입력은 접속 전에 거부한다', async t => {
  const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER };
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  const executed = [];
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({ query: async () => [{ db_name: 'NUMBERS', db_type: 'oracle',
      connection_info: 'unused', db_user: 'reader', db_password: 'unused' }], release: async () => {} }), end: async () => {},
  }));
  t.mock.method(oracledb, 'createPool', async () => ({ getConnection: async () => ({
    execute: async (sql, binds) => {
      if (!sql.startsWith('DECLARE')) return {};
      executed.push(binds.n.val);
      // Oracle의 NUMBER→VARCHAR2 암묵 변환이 실제로 내는 표기 (실 Oracle 실측)
      return { outBinds: { half: '.5', neg: '-.5', whole: '3', big: '123456789012345679', third: '.3333333333333333333333333333333333333333', none: null, text: '3' } };
    },
    rollback: async () => {}, close: async () => {},
  }), close: async () => {} }));
  t.after(async () => {
    await closeOraclePools(); await closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const number = dir => ({ dir, type: 'NUMBER' });
  const row = { query_name: 'numbers', query_type: 'PROCEDURE', target_db_name: 'NUMBERS',
    query_sql: 'BEGIN app.numbers(:n, :half, :neg, :whole, :big, :third, :none, :text); END;',
    bind_config: JSON.stringify({ n: number('IN'), half: number('OUT'), neg: number('OUT'), whole: number('OUT'),
      big: number('OUT'), third: number('OUT'), none: number('OUT'), text: { dir: 'OUT', type: 'STRING' } }) };
  assert.deepEqual((await runQuery(row, { n: '1' })).rows, [{ half: 0.5, neg: -0.5, whole: 3,
    big: '123456789012345679', third: '.3333333333333333333333333333333333333333', none: null, text: '3' }]);
  for (const n of ['0', '0e999', '-0.000', '1e-130', '-1E-130', '9.99e125', '0.000123e-126', 1e-130, 2.5e-7, '123456789012345678901234567890e96']) {
    await runQuery(row, { n });
  }
  for (const n of ['1e126', '-1e126', '10e125', '1e-131', '0.1e-130', '1e-400', '123456789012345678901234567890e97', '+1e+126', 1e-131]) {
    await assert.rejects(runQuery(row, { n }), e => e.safe === true && /NUMBER 범위/.test(e.message), String(n));
  }
  assert.equal(executed.length, 11, '범위 밖 값은 접속(실행)하기 전에 거부되어야 한다');
});
