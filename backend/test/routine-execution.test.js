import { test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import oracledb from 'oracledb';
import { runQuery, closeOraclePools } from '../src/oracle.js';
import { closePool } from '../src/db.js';
import { MAX_ROWS } from '../src/constants.js';

for (const mode of ['success', 'empty', 'fetch-error', 'abort', 'null-cursor', 'cursor-close-error', 'rollback-error', 'release-error', 'all-errors']) {
  test(`루틴 커서 ${mode}: 제한된 fetch와 커서 닫기·rollback·연결 반납`, async t => {
    const env = process.env.ORACLE_MOCK;
    process.env.ORACLE_MOCK = '0';
    const calls = [];
    const controller = new AbortController();
    const cursor = {
      getRows: async count => {
        calls.push(['fetch', count]);
        if (mode === 'fetch-error' || mode === 'all-errors') throw new Error('fetch failed');
        if (mode === 'abort') controller.abort();
        return mode === 'empty' ? [] : [{ VALUE: 42 }];
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
          calls.push(['execute', sql]);
          if (sql === 'SET TRANSACTION READ ONLY') return {};
          assert.equal(options.autoCommit, false);
          assert.equal(binds.result.dir, oracledb.BIND_OUT);
          assert.equal(binds.result.type, oracledb.CURSOR);
          assert.equal(Object.hasOwn(binds.result, 'val'), false);
          return { outBinds: { result: mode === 'null-cursor' ? null : cursor } };
        },
        rollback: async () => { calls.push(['rollback']); if (['rollback-error', 'all-errors'].includes(mode)) throw new Error('rollback failed'); },
        close: async options => {
          calls.push([options?.drop ? 'drop' : 'release']);
          if (mode === 'all-errors' || (mode === 'release-error' && !options?.drop)) throw new Error('release failed');
        },
      }), close: async () => {},
    }));
    t.after(async () => { await closeOraclePools(); await closePool(); if (env === undefined) delete process.env.ORACLE_MOCK; else process.env.ORACLE_MOCK = env; });
    const task = runQuery({ query_name: 'routine', query_type: 'PROCEDURE', target_db_name: 'ROUTINES',
      query_sql: 'BEGIN app.orders(:result); END;', bind_config: '{"result":{"dir":"OUT","type":"CURSOR"}}' },
    { result: 'ignore' }, undefined, null, controller.signal);
    if (mode === 'fetch-error' || mode === 'all-errors') await assert.rejects(task, /fetch failed/);
    else if (mode === 'abort') await assert.rejects(task, { name: 'AbortError' });
    else if (mode === 'null-cursor') await assert.rejects(task, /유효한 REF CURSOR/);
    else assert.deepEqual((await task).rows, mode === 'empty' ? [] : [{ VALUE: 42 }]);
    assert.equal(calls[0][1], 'SET TRANSACTION READ ONLY');
    if (mode !== 'null-cursor') {
      assert.deepEqual(calls.find(c => c[0] === 'fetch'), ['fetch', MAX_ROWS + 1]);
      const dropped = ['cursor-close-error', 'rollback-error', 'all-errors'].includes(mode);
      assert.deepEqual(calls.slice(mode === 'release-error' ? -4 : -3), [['cursor-close'], ['rollback'],
        ...(mode === 'release-error' ? [['release'], ['drop']] : [[dropped ? 'drop' : 'release']])]);
    } else assert.deepEqual(calls.slice(-2), [['rollback'], ['release']]);
  });
}
