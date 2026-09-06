import { test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import oracledb from 'oracledb';
import { closePool } from '../src/db.js';
import { runQuery, closeOraclePools } from '../src/oracle.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

for (const phase of ['acquire', 'execute']) {
  test(`접속 정보 교체는 이전 풀의 진행 중인 ${phase} 요청을 끊지 않는다`, async t => {
    const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER };
    process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
    let password = 'first';
    const entered = deferred(), resume = deferred();
    const pools = [];
    t.mock.method(mariadb, 'createPool', () => ({
      getConnection: async () => ({
        query: async () => [{ db_name: 'TEST_DB', db_type: 'oracle', connection_info: 'test.invalid', db_user: 'test', db_password: password }],
        release: async () => {},
      }), end: async () => {},
    }));
    t.mock.method(oracledb, 'createPool', async config => {
      const first = config.password === 'first';
      const pool = {
        closed: false,
        async getConnection() {
          if (first && phase === 'acquire') { entered.resolve(); await resume.promise; }
          if (pool.closed) throw new Error('pool closed during acquisition');
          return {
            async execute() {
              if (first && phase === 'execute') { entered.resolve(); await resume.promise; }
              if (pool.closed) throw new Error('connection closed during execution');
              return { rows: [{ VALUE: config.password }] };
            },
            close: async () => {},
          };
        },
        async close() { pool.closed = true; },
      };
      pools.push(pool);
      return pool;
    });
    t.after(async () => {
      resume.resolve();
      await closeOraclePools(); await closePool();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const registry = { query_name: 'q', query_sql: 'SELECT 1 FROM dual', target_db_name: 'TEST_DB' };
    const old = runQuery(registry).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    password = 'second';
    const current = await runQuery(registry);
    const closedEarly = pools[0].closed;
    resume.resolve();
    const previous = await old;
    assert.equal(closedEarly, false, '기존 요청이 끝나기 전에 풀을 닫았다');
    assert.equal(previous.error, undefined);
    assert.deepEqual(previous.value.rows, [{ VALUE: 'first' }]);
    assert.deepEqual(current.rows, [{ VALUE: 'second' }]);
    assert.equal(pools[0].closed, true, '이전 요청 반납 뒤에는 교체된 풀을 정리해야 한다');
  });
}

test('Oracle 세션 초기화 SQL에도 조회 타임아웃을 적용한다', async t => {
  const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER };
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  const calls = [];
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({
      query: async () => [{ db_name: 'TIMEOUT_DB', connection_info: 'test.invalid', db_user: 'test', db_password: 'test' }],
      release: async () => {},
    }), end: async () => {},
  }));
  t.mock.method(oracledb, 'createPool', async config => ({
    async getConnection() {
      const conn = {
        callTimeout: 0,
        async execute(sql) { calls.push({ sql, timeout: conn.callTimeout }); return { rows: [{ N: 1 }] }; },
        close: async () => {},
      };
      await new Promise((resolve, reject) => config.sessionCallback(conn, '', error => error ? reject(error) : resolve()));
      return conn;
    }, close: async () => {},
  }));
  t.after(async () => {
    await closeOraclePools(); await closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await runQuery({ query_name: 'q', query_sql: 'SELECT 1 FROM dual', target_db_name: 'TIMEOUT_DB' });
  assert.match(calls[0].sql, /^ALTER SESSION/);
  assert.ok(calls[0].timeout > 0, '접속 중 실행하는 ALTER SESSION이 무제한 대기한다');
  assert.equal(calls[0].timeout, calls[1].timeout);
});
