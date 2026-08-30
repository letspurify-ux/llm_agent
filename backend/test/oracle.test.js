// Oracle 실행기 가드 회귀 테스트 — 실행: npm test
// ORACLE_MOCK=1 경로만 사용한다 (실 DB 불필요). 실행 전 가드(bindProblem)와 mock 조회는
// 실제 접속 여부와 무관하게 같은 코드를 타므로 여기서 검증하는 판정이 실배포에도 그대로 적용된다.
import { test } from 'node:test';
import assert from 'node:assert';
import oracledb from 'oracledb';
import { runQuery, normalizeCells, numberFromString, oracleMock } from '../src/oracle.js';
import { MAX_CELL_LEN, MAX_RESULT_COLS, TRUNC_MARK } from '../src/constants.js';

process.env.ORACLE_MOCK = '1';

const reg = (name, sql = 'SELECT 1 FROM DUAL') => ({ query_name: name, query_sql: sql, target_db_name: 'D' });
const withBind = sql => reg('batch_job_status', 'SELECT 1 FROM T WHERE A = :job_id');

test('프로토타입 멤버와 겹치는 쿼리 이름도 safe 안내로 실패한다', async () => {
  // 'constructor'가 프로토타입 체인을 타면 !gen 가드를 지나쳐 unsafe TypeError로 죽는다 —
  // 사용자에게는 일반 오류 문구, 모델에게는 드라이버 오류처럼 보여 양쪽 다 원인을 잃는다.
  for (const name of ['constructor', '__proto__']) {
    await assert.rejects(
      runQuery(reg(name)),
      e => e.safe === true && /mock 데이터가 정의되지 않은 쿼리/.test(e.message),
      `${name}은 safe 안내로 실패해야 한다`
    );
  }
});

test('값 없는 바인드는 실행 전에 safe 오류로 거부된다', async () => {
  await assert.rejects(
    runQuery(withBind(), {}),
    e => e.safe === true && /값 없음/.test(e.message)
  );
  // 모델 전용 지침은 message가 아니라 hint에 실린다 — message는 사용자 trace에 그대로 나간다
  await assert.rejects(
    runQuery(withBind(), {}),
    e => !/선택하라|되물어/.test(e.message) && /확인하고/.test(e.hint)
  );
});

test('잘린 표시가 붙은 바인드 값은 실행 전에 거부된다', async () => {
  await assert.rejects(
    runQuery(withBind(), { job_id: `x${TRUNC_MARK}` }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
});

test('정확히 절단 길이인 값만 잘린 조각으로 의심한다', async () => {
  // 마크를 뗀 조각은 정확히 MAX_CELL_LEN자다 — 이력 밖(이전 턴 답변)에서 온 조각을 여기서 거른다.
  await assert.rejects(
    runQuery(withBind(), { job_id: 'x'.repeat(MAX_CELL_LEN) }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
  // 그보다 긴 값은 질문에서 온 정당한 입력일 수 있다 — 통과해야 한다 (mock은 0건을 돌려줄 뿐).
  // '이상'으로 잡으면 자유 검색어·경로 같은 긴 값으로는 등록 쿼리를 영영 실행할 수 없다.
  const r = await runQuery(withBind(), { job_id: 'x'.repeat(MAX_CELL_LEN + 50) });
  assert.deepStrictEqual(r.rows, []);
});

test('ORACLE_MOCK 표기를 흡수하고 모르는 값은 실제 접속으로 두되 알린다', () => {
  // '1'만 보면 ORACLE_MOCK=true·yes·on이 전부 '실제 접속'으로 떨어지는데, 기동 배너는 원본 값을
  // 그대로 찍어 'ORACLE_MOCK=true'라고 알린다 — mock인 줄 알고 운영 DB에 붙는다.
  const saved = process.env.ORACLE_MOCK;
  const warned = [];
  const origWarn = console.warn;
  console.warn = m => warned.push(String(m));
  try {
    for (const v of ['1', 'true', 'TRUE', ' on ', 'yes']) {
      process.env.ORACLE_MOCK = v;
      assert.equal(oracleMock(), true, v);
    }
    for (const v of ['0', 'false', 'no', 'off', '']) {
      process.env.ORACLE_MOCK = v;
      assert.equal(oracleMock(), false, v);
    }
    // 모르는 값은 실제 접속(기존 동작)으로 두고 알린다 — 조용히 mock으로 돌리면
    // 운영 DB를 조회했다고 믿는 답변이 stub 데이터로 나간다.
    warned.length = 0;
    process.env.ORACLE_MOCK = 'maybe';
    assert.equal(oracleMock(), false);
    assert.ok(warned.some(m => /ORACLE_MOCK/.test(m)), '모르는 값에 경고가 없다');
  } finally {
    console.warn = origWarn;
    process.env.ORACLE_MOCK = saved ?? '1';   // 이 파일의 나머지 테스트가 mock 경로를 쓴다
  }
});

test('서로게이트 경계에서 잘린 조각도 잘린 값으로 걸러진다', async () => {
  // clipText는 절단 경계가 서로게이트 쌍을 가르면 짝 잃은 상위 서로게이트를 하나 더 뗀다 —
  // 그 셀의 잘린 앞부분은 MAX_CELL_LEN자가 아니라 MAX_CELL_LEN-1자다.
  // 길이 판정이 MAX_CELL_LEN 하나만 보면 이모지가 든 셀에서만 가드가 조용히 빠져,
  // 마크를 뗀 조각이 그대로 바인드되고 0건이 나온다 — 모델은 그 0건을 "그런 데이터가 없다"로
  // 읽으므로 오류 하나 없이 확신에 찬 오답이 나간다. (이력 밖에서 온 조각이라 truncatedBinds도 못 잡는다)
  const clipped = normalizeCells({ C: 'a'.repeat(MAX_CELL_LEN - 1) + '\u{1F600}' + 'tail' }).C;
  const stripped = clipped.slice(0, -TRUNC_MARK.length);
  assert.equal(stripped.length, MAX_CELL_LEN - 1, '이 셀의 잘린 앞부분은 한 칸 짧다');
  await assert.rejects(
    runQuery(withBind(), { job_id: stripped }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
  // 그보다 한 칸 더 짧은 값은 절단으로 생길 수 없다 — 정당한 입력이므로 통과해야 한다.
  const r = await runQuery(withBind(), { job_id: 'x'.repeat(MAX_CELL_LEN - 2) });
  assert.deepStrictEqual(r.rows, []);
});

test('컬럼 수가 상한을 넘는 행은 드라이버 경계에서 잘리고 표시가 남는다', () => {
  // 셀 길이·행 수만 묶고 컬럼 수를 열어두면 SELECT * 넓은 테이블의 행 하나가
  // 프롬프트 예산과 답변·trace·chat_log를 그대로 관통한다.
  const wide = Object.fromEntries(new Array(MAX_RESULT_COLS + 5).fill(0).map((_, i) => [`C${i}`, i]));
  const row = normalizeCells(wide);
  assert.strictEqual(Object.keys(row).length, MAX_RESULT_COLS + 1); // 상한 + 생략 표시
  assert.match(String(row['…']), /5개 컬럼 생략/, '자른 사실이 행 안에 남아야 한다');
  // 상한 이하의 행은 손대지 않는다
  assert.deepStrictEqual(normalizeCells({ A: 1, B: null }), { A: 1, B: null });
});

test('NUMBER 문자열은 정밀도가 보존될 때만 숫자로 되돌린다', () => {
  // 전부 숫자로 바꾸면 16자리+가 조용히 반올림되고, 전부 문자열로 두면 mock(숫자 리터럴)과
  // 실제의 JSON 표기가 갈라진다 — 왕복이 정확한 값만 숫자로.
  assert.strictEqual(numberFromString('128000'), 128000);
  assert.strictEqual(numberFromString('12.5'), 12.5);
  assert.strictEqual(numberFromString('0'), 0);
  assert.strictEqual(numberFromString(null), null);
  // 배정밀도로 반올림되는 18자리 채번 키 — 숫자로 바꾸면 끝자리가 달라진다
  assert.strictEqual(numberFromString('123456789012345678'), '123456789012345678');
});

test('바인드명이 프로토타입 멤버와 겹쳐도 판정이 어긋나지 않는다', async () => {
  // params?.['__proto__']가 Object.prototype을 돌려주면 '값 없음'이 '값이 아닌 구조'로 둔갑한다
  await assert.rejects(
    runQuery(reg('batch_job_status', 'SELECT 1 FROM T WHERE A = :__proto__'), {}),
    e => e.safe === true && /값 없음/.test(e.message)
  );
});

test('음수 scale NUMBER는 정밀도 가드를 우회하지 못한다', () => {
  // 값이 가질 수 있는 자릿수는 precision이 아니라 precision - scale이다. precision만 보면
  // NUMBER(15,-2)가 '안전이 증명된 열'로 분류돼 17자리 값이 배정밀도에서 조용히 반올림된다 —
  // 이 핸들러가 막겠다고 한 바로 그 실패가 이 한 유형에서만 살아남는다.
  const md = (precision, scale) => ({ dbType: oracledb.DB_TYPE_NUMBER, precision, scale });
  const asString = m => oracledb.fetchTypeHandler(m)?.type === oracledb.STRING;

  assert.ok(asString(md(15, -2)), '음수 scale은 값의 크기를 precision 밖으로 늘린다');
  assert.ok(asString(md(9, -9)), '유효 숫자가 적어도 자릿수는 18자리까지 간다');
  assert.ok(asString(md(0, -127)), '선언 없는 NUMBER는 정밀도가 미상이다');
  assert.ok(asString(md(18, 0)), '18자리는 배정밀도를 넘는다');
  assert.ok(asString(md(15, undefined)), 'scale이 없는 메타데이터는 안전이 증명되지 않은 쪽이다');

  // 반대 방향도 지킨다 — 정밀도가 보장되는 열까지 문자열로 바꾸면 mock(숫자 리터럴)과
  // 실제의 JSON 표기가 갈라져, mock으로 검증한 시나리오가 실제 배포에서 재현되지 않는다.
  assert.ok(!asString(md(12, 2)), 'NUMBER(12,2)는 기본 숫자 매핑 그대로여야 한다');
  assert.ok(!asString(md(15, 0)), 'NUMBER(15)는 안전하다');
  assert.ok(!asString({ dbType: oracledb.DB_TYPE_VARCHAR, precision: 0, scale: -127 }), 'NUMBER가 아닌 타입은 건드리지 않는다');

  // 위 판정이 실제 손실을 막고 있는지 — 17자리는 double 왕복에서 끝자리가 바뀐다
  assert.notStrictEqual(Number('12345678901234567').toString(), '12345678901234567');
});
