// Oracle 실행기 가드 회귀 테스트 — 실행: npm test
// ORACLE_MOCK=1 경로만 사용한다 (실 DB 불필요). 실행 전 가드(bindProblem)와 mock 조회는
// 실제 접속 여부와 무관하게 같은 코드를 타므로 여기서 검증하는 판정이 실배포에도 그대로 적용된다.
import { test } from 'node:test';
import assert from 'node:assert';
import oracledb from 'oracledb';
import { runQuery, normalizeCells, numberFromString, oracleMock, oracleDriver, resolveTargetDb } from '../src/oracle.js';
import { targetDbNames } from '../src/constants.js';
import { llmProvider } from '../src/llm.js';
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

test('바인드명 대소문자는 Oracle과 같이 무시한다', async () => {
  // Oracle은 :job_id와 :JOB_ID를 같은 바인드로 다룬다. 여기서만 정확한 철자를 요구하면 모델이
  // 값을 제대로 채워 보내고도 '값 없음'으로 실패한다 — 프롬프트는 SQL 원문의 대문자 컬럼명과
  // 소문자 바인드명을 함께 보여주고 조회 결과 행의 키도 대문자라, {"JOB_ID": …}는 흔한 정상 응답이다.
  // 실패하면 스텝 하나와 LLM 왕복 하나를 버리는데, 오류 문구는 '값을 안 줬다'고 말해
  // 모델을 엉뚱한 수정으로 보낸다. llm.js valueFromHistory는 같은 이유로 이미 대소문자를 무시한다.
  for (const params of [{ JOB_ID: 'BATCH001' }, { Job_Id: 'BATCH001' }, { job_id: 'BATCH001' }]) {
    const { rows } = await runQuery(withBind(), params);
    assert.equal(rows.length, 1, `바인드되지 않았다: ${JSON.stringify(params)}`);
    assert.equal(rows[0].JOB_ID, 'BATCH001');
  }
  // 값이 정말 없으면 그대로 거부한다 — 관대해진 판정이 '값 없음'까지 삼키면 안 된다
  await assert.rejects(runQuery(withBind(), { JOB: 'BATCH001' }), e => e.safe === true && /값 없음/.test(e.message));
});

test('잘린 표시가 붙은 바인드 값은 실행 전에 거부된다', async () => {
  await assert.rejects(
    runQuery(withBind(), { job_id: `x${TRUNC_MARK}` }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
});

test('잘린 조각인지는 길이가 아니라 실제로 자른 값과의 대조로 판정한다', async () => {
  // 마크를 뗀 조각은 '우리가 자른 값'과 글자까지 같다 — 그 대조로만 거른다.
  const clipped = normalizeCells({ C: 'x'.repeat(MAX_CELL_LEN + 50) }).C;
  const stripped = clipped.slice(0, -TRUNC_MARK.length);
  await assert.rejects(
    runQuery(withBind(), { job_id: stripped }, v => v === stripped),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
  // 같은 길이라도 우리가 자른 적 없는 값은 정당한 입력이다 — 통과해야 한다 (mock은 0건을 돌려줄 뿐).
  // 길이로 판정하면 사용자가 붙여넣은 200자짜리 검색어·경로로는 등록 쿼리를 영영 실행할 수 없다.
  for (const len of [MAX_CELL_LEN - 1, MAX_CELL_LEN, MAX_CELL_LEN + 50]) {
    const r = await runQuery(withBind(), { job_id: 'y'.repeat(len) });
    assert.deepStrictEqual(r.rows, [], `${len}자 값은 잘린 조각이 아니다`);
  }
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

test('ORACLE_DRIVER 표기를 흡수하고 모르는 값은 thin으로 두되 알린다', () => {
  // 모드를 잘못 읽으면 배너가 'ORACLE_DRIVER=oci'라고 알리면서 실제로는 thin으로 붙는다 —
  // ORACLE_MOCK과 같은 함정이라 같은 방식으로 막는다. 폴백이 thin인 이유는 붙는 DB가 같기
  // 때문이다(접속 경로만 다르다): 어긋나도 그대로 동작하거나 즉시 접속 실패로 드러난다.
  const saved = process.env.ORACLE_DRIVER;
  const warned = [];
  const origWarn = console.warn;
  console.warn = m => warned.push(String(m));
  try {
    for (const v of ['thin', 'THIN', ' thin ', '']) {
      process.env.ORACLE_DRIVER = v;
      assert.equal(oracleDriver(), 'thin', v);
    }
    delete process.env.ORACLE_DRIVER;
    assert.equal(oracleDriver(), 'thin', '미설정');
    // 'thick'은 node-oracledb 문서가 쓰는 이름이다 — 그 철자로 적어도 oci로 읽는다.
    for (const v of ['oci', 'OCI', 'thick', ' Thick ']) {
      process.env.ORACLE_DRIVER = v;
      assert.equal(oracleDriver(), 'oci', v);
    }
    warned.length = 0;
    process.env.ORACLE_DRIVER = 'ocl';
    assert.equal(oracleDriver(), 'thin');
    assert.ok(warned.some(m => /ORACLE_DRIVER/.test(m)), '모르는 값에 경고가 없다');
  } finally {
    console.warn = origWarn;
    if (saved === undefined) delete process.env.ORACLE_DRIVER;
    else process.env.ORACLE_DRIVER = saved;
  }
});

test('서로게이트 경계에서 잘린 조각도 잘린 값으로 걸러진다', async () => {
  // clipText는 절단 경계가 서로게이트 쌍을 가르면 짝 잃은 상위 서로게이트를 하나 더 뗀다 —
  // 그 셀의 잘린 앞부분은 MAX_CELL_LEN자가 아니라 MAX_CELL_LEN-1자다.
  // 길이로 판정하던 시절에는 이 한 칸 때문에 이모지가 든 셀에서만 가드가 조용히 빠졌다.
  // 대조로 판정하면 절단 길이가 몇이든 상관이 없다 — 값이 같은지만 보기 때문이다.
  const clipped = normalizeCells({ C: 'a'.repeat(MAX_CELL_LEN - 1) + '\u{1F600}' + 'tail' }).C;
  const stripped = clipped.slice(0, -TRUNC_MARK.length);
  assert.equal(stripped.length, MAX_CELL_LEN - 1, '이 셀의 잘린 앞부분은 한 칸 짧다');
  await assert.rejects(
    runQuery(withBind(), { job_id: stripped }, v => v === stripped),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
  // 마크가 그대로 붙어 온 값은 판정자 없이도 걸린다 (판정 경로가 둘인 것을 함께 확인한다).
  await assert.rejects(
    runQuery(withBind(), { job_id: clipped }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
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
  // 손실 판정은 자릿수가 아니라 왕복이 정한다: 2^53(약 9.0e15)을 넘어 표현되지 않는 값만 문자열로 남는다.
  assert.strictEqual(numberFromString('9999999999999999'), '9999999999999999', '2^53을 넘어 반올림된다');
  assert.strictEqual(numberFromString('123456789012345'), 123456789012345, '15자리는 왕복이 정확하다');
  assert.strictEqual(numberFromString('1234567890123456'), 1234567890123456, '16자리여도 2^53 아래는 정확하다');
});

test('Oracle의 정상 표기를 손실로 오판하지 않는다', () => {
  // 판정 기준은 '값이 보존되는가'이지 '표기가 같은가'가 아니다. String(n) === v로 재면
  // Oracle이 실제로 주는 표기가 전부 문자열로 남는다 — 앞의 0을 생략한 '.5', 선언된 scale만큼
  // 0을 유지하는 '1.0'·'0.10'. 이 변환기를 타는 열은 '선언된 precision이 없는 NUMBER',
  // 즉 SUM()·AVG()·비율 같은 모든 식의 결과라 집계값 전부가 해당된다.
  // 그러면 {"AVG_AMOUNT":".5"}처럼 따옴표 붙은 채로 프롬프트·답변·chat_log에 들어가,
  // 모델은 mock(숫자 리터럴)과 다른 타입을 놓고 추론한다 — 이 함수가 막겠다고 한 그 어긋남이다.
  assert.strictEqual(numberFromString('.5'), 0.5);
  assert.strictEqual(numberFromString('1.0'), 1);
  assert.strictEqual(numberFromString('0.10'), 0.1);
  assert.strictEqual(numberFromString('-.5'), -0.5);
  assert.strictEqual(numberFromString('1000'), 1000);
  // 표현 범위를 벗어나면 값을 통째로 잃는다 — 그때는 문자열로 남긴다
  assert.strictEqual(numberFromString('1e400'), '1e400');
  assert.strictEqual(numberFromString('1e-400'), '1e-400');
  // 숫자 표기가 아닌 값은 손대지 않는다
  assert.strictEqual(numberFromString('abc'), 'abc');
  assert.strictEqual(numberFromString(''), '');
  for (const junk of ['+', '-', '.', 'e5', '1e', '1.2.3', '1,234', 'Infinity', '0x10']) {
    assert.strictEqual(numberFromString(junk), junk, junk);
  }
});

test('비정규수 구간에서도 값을 잃지 않는다', () => {
  // "유효숫자 15자리 이하면 배정밀도 왕복이 안전하다"는 어림은 정규수에서만 성립한다.
  // 2^-1022(약 2.2e-308) 아래는 가수 비트가 줄어들어 5e-324에서는 한 비트만 남으므로,
  // 유효숫자가 네 자리여도 값이 뭉개진다 — 자릿수만 세는 판정은 이 구간을 통째로 놓친다.
  // (퍼징으로 잡은 회귀다: 자릿수 어림 판정이 '20980e-326'을 2.08e-322로 바꿔 내보냈다)
  for (const v of ['20980e-326', '7765e-327', '5e-324', '1.5e-323']) {
    const out = numberFromString(v);
    if (typeof out === 'number') {
      // 숫자로 돌렸다면 그 값이 원본과 같은 값이어야 한다 (가장 짧은 표기가 곧 그 증거다)
      assert.strictEqual(Number(String(out)), Number(v), v);
      assert.strictEqual(String(out).replace(/[+]/g, ''), String(Number(v)).replace(/[+]/g, ''), v);
    }
    assert.notStrictEqual(out, 2.08e-322, `${v}이 다른 값으로 바뀌었다`);
  }
  assert.strictEqual(numberFromString('20980e-326'), '20980e-326', '값이 뭉개지는 구간은 문자열로 남아야 한다');
});

test('표기가 달라도 값이 같으면 숫자로 되돌린다', () => {
  // 판정 기준은 표기 일치(String(n) === v)가 아니라 값 동일성이다 — 그 어림이 Oracle의
  // 정상 표기를 전부 손실로 오판했고, 반대로 자릿수 어림은 비정규수를 놓쳤다.
  // 유효숫자 16~17자리여도 왕복이 정확하면 숫자로 돌린다.
  assert.strictEqual(numberFromString('.8896558657424347'), 0.8896558657424347);
  assert.strictEqual(numberFromString('29387210.7049420140'), 29387210.704942014);
  assert.strictEqual(numberFromString('003368761374974852'), 3368761374974852);
  assert.strictEqual(numberFromString('0.1e1'), 1);
  assert.strictEqual(numberFromString('10e-1'), 1);
  // 왕복이 어긋나면 자릿수와 무관하게 문자열로 남는다
  assert.strictEqual(numberFromString('12345678901234567'), '12345678901234567');
  assert.strictEqual(numberFromString('10000000000000001'), '10000000000000001');
});

test('boolean 바인드는 드라이버까지 내려가기 전에 거부된다', async () => {
  // node-oracledb는 Oracle 23ai 미만에 JS boolean을 바인드할 수 없다. 통과시키면 접속을 열고
  // 세션 포맷까지 건 뒤 conn.execute 안에서 드라이버 원문 오류로 죽는데, 그 원문은 화면에서
  // 가려지므로(server.js) 사용자에게는 '조회 중 오류' 한 줄, 모델에게는 아무 단서도 남지 않는다.
  // ':active = 활성 여부'처럼 설명된 바인드에 모델이 true를 채우는 건 자연스러운 완성이라 실제로 온다.
  for (const v of [true, false]) {
    await assert.rejects(
      runQuery(withBind(), { job_id: v }),
      e => e.safe === true && /true\/false는 바인드할 수 없음/.test(e.message),
      String(v)
    );
  }
  // 숫자·문자열은 그대로 통과한다 (mock은 0건을 돌려줄 뿐)
  assert.deepStrictEqual((await runQuery(withBind(), { job_id: 1 })).rows, []);
});

test('바인드명이 프로토타입 멤버와 겹쳐도 판정이 어긋나지 않는다', async () => {
  // params?.['constructor']가 Object.prototype의 함수를 돌려주면 '값 없음'이 '값이 아닌 구조'로 둔갑한다.
  // ('__proto__'가 아니라 'constructor'로 재는 이유: '__proto__'는 영문자로 시작하지 않아 Oracle이
  //  바인드로 받지 않고 sql.js 가드가 그 앞에서 거부한다 — 이 판정에 닿는 이름은 전부 적법한 식별자다)
  for (const name of ['constructor', 'toString', 'valueOf']) {
    await assert.rejects(
      runQuery(reg('batch_job_status', `SELECT 1 FROM T WHERE A = :${name}`), {}),
      e => e.safe === true && /값 없음/.test(e.message),
      name
    );
  }
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

test('설정 오타 둘이 겹쳐도 경고가 무한히 쌓이지 않는다', () => {
  // LLM_PROVIDER와 ORACLE_MOCK은 .env의 같은 블록에 있어 함께 틀리는 일이 흔한데, 둘이 한
  // warnOnce scope('setup')를 쓰면 서로 다른 두 문구가 번갈아 들어와 억제가 한 번도 걸리지 않는다.
  // oracleMock은 조회마다, llmProvider는 결정마다 불리므로 요청당 두 줄씩 프로세스 수명 내내 쌓인다.
  // 두 설정 다 폴백이 있어 기능은 도는 탓에 증상이 '로그가 터진다'뿐이라 원인이 보이지 않는다.
  const savedMock = process.env.ORACLE_MOCK;
  const savedProvider = process.env.LLM_PROVIDER;
  const warned = [];
  const origWarn = console.warn;
  console.warn = m => warned.push(String(m));
  try {
    // 이 파일의 다른 테스트가 쓰지 않은 값을 쓴다 — warnOnce는 scope별 '마지막 문구'를 기억하므로
    // 같은 값으로 이미 한 번 경고했다면 이 테스트가 재는 것이 억제인지 중복인지 구분되지 않는다.
    process.env.ORACLE_MOCK = 'perhaps';
    process.env.LLM_PROVIDER = 'vllm-typo';
    for (let i = 0; i < 5; i++) {
      oracleMock();
      llmProvider();
    }
    assert.equal(warned.length, 2, `설정 항목마다 1회여야 한다: ${warned.length}줄`);
    assert.ok(warned.some(m => /ORACLE_MOCK/.test(m)) && warned.some(m => /LLM_PROVIDER/.test(m)));
  } finally {
    console.warn = origWarn;
    process.env.ORACLE_MOCK = savedMock;
    if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = savedProvider;
  }
});

test('mock 생성기도 바인드명 표기에 좌우되지 않는다', async () => {
  // binds의 키는 등록 SQL의 철자 그대로다(bindNames). MOCK_DATA 생성기가 p.job_id로 읽으므로
  // `:JOB_ID`로 등록하면 mock만 0건이 되어, 실 Oracle에서는 되는 조회가 데모에서만 빈 결과가 된다 —
  // 등록 실수로 오인하기 딱 좋은 형태다 (query_name을 nameKey로 낮추는 것과 같은 이유).
  for (const bind of ['job_id', 'JOB_ID', 'Job_Id']) {
    const sql = `SELECT 1 FROM T WHERE A = :${bind}`;
    const { rows } = await runQuery(reg('batch_job_status', sql), { [bind]: 'BATCH001' });
    assert.equal(rows.length, 1, `${bind}: mock이 0건을 돌려줬다`);
    assert.equal(rows[0].JOB_ID, 'BATCH001');
  }
});

// --- 조회대상 DB 선택 (target_db_name의 ';' 목록) ---------------------------------
const multi = list => ({ query_name: 'batch_job_status', query_sql: 'SELECT 1 FROM DUAL', target_db_name: list });

test('후보가 하나면 고르지 않아도 그 DB로 실행된다', () => {
  // 목록형을 쓰지 않는 기존 등록은 전부 지금까지와 똑같이 돌아야 한다 —
  // 여기가 깨지면 이 기능과 무관한 모든 쿼리가 '대상 DB를 고르지 않았다'로 죽는다.
  assert.equal(resolveTargetDb(multi('ORDER_DB'), null), 'ORDER_DB');
  assert.equal(resolveTargetDb(multi(' ORDER_DB ; '), undefined), 'ORDER_DB');
});

test('후보가 여럿인데 고르지 않으면 후보를 들고 되묻는다', () => {
  // 첫 후보로 조용히 폴백하면 '엉뚱한 DB의 결과'가 정답 행세를 하며 답변·trace·chat_log
  // 어디에도 흔적을 남기지 않는다 — 이 코드베이스가 막기로 한 조용한 오답 그 자체다.
  assert.throws(() => resolveTargetDb(multi('SEOUL;BUSAN'), ''), e => {
    assert.ok(e.safe, '사용자 화면에 나갈 수 있는 문구여야 한다');
    // 조회를 시작하지도 못한 스텝이라는 표시 — agent.js가 이것으로 연속 낭비를 끊는다.
    // 없으면 모델이 매번 다른 틀린 이름을 대는 동안 MAX_STEPS를 전부 소진한다.
    assert.equal(e.wastedStep, true, 'wastedStep 표시가 없다');
    assert.match(e.message, /고르지 않았습니다/);
    assert.match(e.message, /SEOUL, BUSAN/);      // 무엇 중에서 고를지 문구가 알려준다
    assert.match(e.hint, /target_db/);            // 모델에게는 고치는 방법을 준다
    return true;
  });
});

test('후보 밖의 이름은 거부하고, 대소문자만 다르면 등록 철자로 돌려준다', () => {
  // 모델이 만든 문자열을 그대로 loadTargetDb에 넘기면 '접속 정보 미등록'으로 보고되어,
  // 모델이 고칠 수 있는 실패(이름 오타)가 고칠 수 없는 실패(운영자 미등록)로 읽힌다.
  assert.throws(() => resolveTargetDb(multi('SEOUL;BUSAN'), 'DAEGU'), e => {
    assert.ok(e.safe);
    assert.equal(e.wastedStep, true, 'wastedStep 표시가 없다');
    assert.match(e.message, /등록되지 않은 대상 DB/);
    assert.match(e.message, /DAEGU/);
    assert.match(e.message, /SEOUL, BUSAN/);
    return true;
  });
  // 돌려주는 것은 모델이 적은 철자가 아니라 등록 철자다 — 이력·trace·접속이 같은 이름을 본다.
  assert.equal(resolveTargetDb(multi('SEOUL;BUSAN'), 'busan'), 'BUSAN');
  assert.equal(resolveTargetDb(multi('SEOUL;BUSAN'), ' Seoul '), 'SEOUL');
});

test('대상 DB가 비어 있으면 되묻지 않고 실행 불가로 끝낸다', () => {
  // 운영자의 등록 실수다 — 모델이 무엇을 골라도 달라지지 않으므로 후보를 되물어봐야
  // 스텝과 LLM 왕복만 소진한다.
  assert.throws(() => resolveTargetDb(multi(' ; '), 'SEOUL'), e => {
    assert.ok(e.safe);
    assert.equal(e.wastedStep, true, 'wastedStep 표시가 없다');
    assert.match(e.message, /등록되어 있지 않습니다/);
    assert.doesNotMatch(e.hint, /target_db/);
    return true;
  });
});

test('조회 결과에 어느 DB에서 돌았는지가 함께 실린다', async () => {
  // 이력·trace·화면이 '어느 DB의 결과인가'를 알 수 있는 유일한 경로다. mock 경로에서도
  // 같은 판정을 지나야 한다 — mock만 건너뛰면 'mock에서는 되는데 실제로는 죽는' 조합이 생긴다.
  const one = await runQuery(multi('ORDER_DB'), { job_id: 'B1' });
  assert.equal(one.targetDb, 'ORDER_DB');
  const picked = await runQuery(multi('SEOUL;BUSAN'), { job_id: 'B1' }, undefined, 'busan');
  assert.equal(picked.targetDb, 'BUSAN', '등록 철자로 돌아와야 한다');
  await assert.rejects(runQuery(multi('SEOUL;BUSAN'), { job_id: 'B1' }), /고르지 않았습니다/);
});

test('대상 DB 선택은 어떤 입력에도 후보 하나로만 확정된다', () => {
  // 이 판정이 뚫리는 방향은 둘이고 둘 다 조용하다.
  //   ① 목록이 통째로 넘어가면 loadTargetDb가 'A;B'라는 이름을 찾다 0건을 돌려주고,
  //      실패는 '접속 정보 미등록'으로 보고되어 원인이 세미콜론이라는 사실을 가리지 못한다.
  //   ② 고르지 않았는데 통과하면 엉뚱한 DB의 결과가 정답 행세를 한다.
  // 문자열이 아닌 값도 함께 훑는다 — String(['A'])가 'A'가 되는 탓에 단일 원소 배열이
  // 후보에 그대로 매칭됐다(실측). 결정 경계가 이미 걸러내지만, 가드는 실행 경계 한 곳에서
  // 성립해야 하고 그 경계에는 결정 경계를 지나지 않는 호출(테스트·CLI)도 들어온다.
  const reg = list => ({ query_name: 'q', query_sql: 'SELECT 1 FROM DUAL', target_db_name: list });
  const lists = ['A;B;C', 'A;B', ' A ; B ; ', 'A;;B', 'A;a;B', 'ORDER_DB', '', ';', 'A;B'.repeat(50)];
  const choices = [undefined, null, '', '  ', 'A', 'a', ' A ', 'A;B', 'A;', ';A', 'Z', 0, 1, true,
                   [], {}, ['A'], 'A'.repeat(200), '__proto__', 'constructor'];
  for (const list of lists) {
    const names = targetDbNames(list);
    for (const c of choices) {
      let got;
      try {
        got = resolveTargetDb(reg(list), c);
      } catch (e) {
        assert.ok(e.safe, `사용자에게 보일 수 없는 오류: ${list} / ${JSON.stringify(c)}`);
        continue;
      }
      assert.ok(!String(got).includes(';'), `목록이 통째로 넘어갔다: ${list} / ${JSON.stringify(c)} → ${got}`);
      assert.ok(names.includes(got), `후보 밖을 돌려줬다: ${list} / ${JSON.stringify(c)} → ${got}`);
      // 후보가 여럿이면 '문자열로 고른' 경우에만 통과해야 한다
      if (names.length > 1) {
        assert.equal(typeof c, 'string', `고르지 않았는데 통과했다: ${list} / ${JSON.stringify(c)} → ${got}`);
        assert.ok(c.trim(), `빈 선택이 통과했다: ${list} / ${JSON.stringify(c)} → ${got}`);
      }
    }
  }
});
