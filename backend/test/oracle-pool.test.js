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

test('요청 취소는 실행 중인 Oracle 문장을 끊고 커넥션을 반납한다', async t => {
  const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER };
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  const entered = deferred();
  let rejectExecution; let breaks = 0; let closes = 0;
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({
      query: async () => [{ db_name: 'CANCEL_DB', db_type: 'oracle', connection_info: 'test.invalid', db_user: 'test', db_password: 'test' }],
      release: async () => {},
    }), end: async () => {},
  }));
  t.mock.method(oracledb, 'createPool', async config => ({
    async getConnection() {
      const conn = {
        callTimeout: 0,
        async execute(sql) {
          if (/^ALTER SESSION/.test(sql)) return { rows: [] };
          entered.resolve();
          return new Promise((_resolve, reject) => { rejectExecution = reject; });
        },
        async breakExecution() {
          breaks++;
          rejectExecution?.(Object.assign(new Error('ORA-01013: user requested cancel'), { errorNum: 1013 }));
        },
        async close() { closes++; },
      };
      await new Promise((resolve, reject) => config.sessionCallback(conn, '', error => error ? reject(error) : resolve()));
      return conn;
    },
    close: async () => {},
  }));
  t.after(async () => {
    await closeOraclePools(); await closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const controller = new AbortController();
  const running = runQuery(
    { query_name: 'q', query_sql: 'SELECT 1 FROM dual', target_db_name: 'CANCEL_DB' },
    {}, undefined, undefined, controller.signal,
  );
  await entered.promise;
  controller.abort();
  await assert.rejects(running, /ORA-01013/);
  assert.equal(breaks, 1);
  assert.equal(closes, 1, '취소한 쿼리의 풀 커넥션을 반납하지 않았다');
});

// 등록 행은 있는데 접속에 쓸 값이 비어 있으면 접속을 시도하지 않는다.
// ENV: 경로(resolvePassword)는 처음부터 그렇게 한다 — 그 주석이 근거까지 적어 두었다:
// "시도하면 DB는 ORA-01017을 돌려주고, 운영자는 설정 누락이 아니라 저장된 자격증명이 틀렸다고 읽는다.
//  게다가 빈 비밀번호 로그인이 매 조회마다 반복되면 공용 조회 계정이 FAILED_LOGIN_ATTEMPTS에 걸려 잠긴다."
// 평문 등록에는 그 판정이 없어서, 같은 실수가 같은 결과를 냈다 — 실 Oracle(FREEPDB1)로 실측하면
// {user:'APP_USER', password:''}는 클라이언트에서 막히지 않고 서버가 ORA-01017을 돌려준다(= 로그인 시도).
// 빈 사용자명도 같다({user:'', password:''} → ORA-01017). 외부 인증을 깨지 않는다: 그 경로는 속성을
// '비우는' 것이 아니라 '주지 않는' 것이고, NULL을 그대로 넘기면 지금도 NJS-007로 죽는다(실측).
test('접속 정보가 빈 등록으로는 조회 DB에 로그인을 시도하지 않는다', async t => {
  const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER };
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  let row;
  let 접속시도 = 0;
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({ query: async () => [row], release: async () => {} }), end: async () => {},
  }));
  t.mock.method(oracledb, 'createPool', async () => {
    접속시도++;
    throw Object.assign(new Error('ORA-01017: invalid username/password; logon denied'), { errorNum: 1017 });
  });
  t.after(async () => {
    await closeOraclePools(); await closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const registry = { query_name: 'q', query_sql: 'SELECT 1 FROM dual', target_db_name: 'TEST_DB' };
  const base = { db_name: 'TEST_DB', db_type: 'oracle', connection_info: 'test.invalid', db_user: 'app', db_password: 'secret' };
  const 빈값 = [['빈 비밀번호', { db_password: '' }], ['NULL 비밀번호', { db_password: null }],
    ['빈 사용자명', { db_user: '' }], ['NULL 사용자명', { db_user: null }],
    // 접속 문자열이 비면 어느 DB인지를 등록이 아니라 클라이언트 기본값이 정한다 —
    // Thick(oci)에서는 ORACLE_SID/TWO_TASK가 가리키는 로컬 인스턴스로 간다(실측 ORA-12162).
    ['빈 접속 문자열', { connection_info: '' }], ['NULL 접속 문자열', { connection_info: null }]];
  for (const [이름, 결손] of 빈값) {
    row = { ...base, ...결손 };
    접속시도 = 0;
    await assert.rejects(runQuery(registry), e =>
      e.safe === true && e.wastedStep === true && /접속 정보가 서버에 설정되어 있지 않습니다/.test(e.message), 이름);
    assert.equal(접속시도, 0, `${이름}: 빈 값으로 조회 DB에 로그인을 시도했다`);
  }
  // 과교정 방지 — 정상 등록은 종전대로 접속을 시도하고, 그 실패는 드라이버 원문 그대로다.
  row = { ...base };
  접속시도 = 0;
  await assert.rejects(runQuery(registry), e => e.safe !== true && /ORA-01017/.test(e.message));
  assert.equal(접속시도, 1, '정상 등록인데 접속을 시도하지 않았다');
});

// 위 가드의 형제 갈래 — 'ENV:변수명'으로 등록한 비밀번호. 이쪽에는 처음부터 판정이 있었지만
// 검사가 없었다(변이로 `typeof stored === 'string'`을 뒤집어도 아무 테스트도 잡지 못했다).
// 둘이 같은 문구·같은 표시로 실패해야 운영자가 '평문이 비었나 ENV가 비었나'를 로그에서 가른다.
test('ENV: 비밀번호는 서버 환경변수에서 읽고, 비어 있으면 접속을 시도하지 않는다', async t => {
  const saved = { ORACLE_MOCK: process.env.ORACLE_MOCK, ORACLE_DRIVER: process.env.ORACLE_DRIVER,
    ORDER_DB_PW: process.env.ORDER_DB_PW };
  process.env.ORACLE_MOCK = '0'; process.env.ORACLE_DRIVER = 'thin';
  let row;
  const 받은비밀번호 = [];
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({ query: async () => [row], release: async () => {} }), end: async () => {},
  }));
  t.mock.method(oracledb, 'createPool', async config => {
    받은비밀번호.push(config.password);
    throw new Error('ORA-12541: TNS:no listener');
  });
  t.after(async () => {
    await closeOraclePools(); await closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const registry = { query_name: 'q', query_sql: 'SELECT 1 FROM dual', target_db_name: 'TEST_DB' };
  const base = { db_name: 'TEST_DB', db_type: 'oracle', connection_info: 'test.invalid', db_user: 'app' };

  // 변수에 값이 있으면 그 값으로 접속한다 (등록 문자열이 그대로 나가지 않는다)
  process.env.ORDER_DB_PW = '진짜비밀번호';
  row = { ...base, db_password: 'ENV:ORDER_DB_PW' };
  await assert.rejects(runQuery(registry), e => /ORA-12541/.test(e.message));
  assert.deepEqual(받은비밀번호, ['진짜비밀번호'], '등록 문자열을 그대로 비밀번호로 보냈다');

  // 변수가 없거나 비면 접속을 시도하지 않고, 평문이 빈 경우와 같은 문구·같은 표시로 실패한다
  for (const [이름, value] of [['미설정', undefined], ['빈 값', '']]) {
    if (value === undefined) delete process.env.ORDER_DB_PW; else process.env.ORDER_DB_PW = value;
    받은비밀번호.length = 0;
    await assert.rejects(runQuery(registry), e =>
      e.safe === true && e.wastedStep === true && /접속 정보가 서버에 설정되어 있지 않습니다/.test(e.message), 이름);
    assert.equal(받은비밀번호.length, 0, `${이름}: 빈 비밀번호로 로그인을 시도했다`);
  }
  // 대소문자를 가리지 않는다 — 'env:'로 등록하면 그 문자열 자체가 비밀번호로 나가 매 조회가 ORA-01017이 된다
  process.env.ORDER_DB_PW = '진짜비밀번호';
  받은비밀번호.length = 0;
  row = { ...base, db_password: ' Env:ORDER_DB_PW ' };
  await assert.rejects(runQuery(registry), e => /ORA-12541/.test(e.message));
  assert.deepEqual(받은비밀번호, ['진짜비밀번호']);
});
