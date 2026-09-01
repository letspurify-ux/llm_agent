// 공유 헬퍼 회귀 테스트 — 실행: npm test
// clipText/nameKey는 절단과 이름 비교가 일어나는 모든 곳(프롬프트·임베딩·조회 셀·루프 가드·mock)이
// 함께 쓴다. 여기가 어긋나면 어긋난 티가 나지 않는 자리에서 조용히 갈라진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { clipText, nameKey, stripLoneSurrogates, numEnv, bindValue, warnOnce, targetDbNames } from '../src/constants.js';

test('절단이 서로게이트 쌍을 쪼개지 않는다', () => {
  // 쪼개면 짝 잃은 코드유닛이 남아 JSON은 통과하지만 유효한 UTF-8이 아니게 된다 —
  // 임베딩 서버가 그 행만 매 주기 거부하거나, 프롬프트 본문이 조용히 훼손된다.
  const boundary = 'a'.repeat(9) + '😀' + 'b'.repeat(5); // 경계(10)에 4바이트 문자가 걸린다
  const cut = clipText(boundary, 10);
  assert.ok(cut.isWellFormed(), `짝 잃은 서로게이트가 남았다: ${JSON.stringify(cut)}`);
  assert.equal(cut, 'a'.repeat(9));
  assert.ok(clipText(boundary, 11).isWellFormed()); // 이모지가 온전히 들어가는 경계는 그대로
});

test('상한 이하는 원본 그대로 돌려준다', () => {
  assert.equal(clipText('abc', 10), 'abc');
  assert.equal(clipText('abcd', 4), 'abcd'); // 정확히 상한
  assert.equal(clipText('abcde', 4), 'abcd');
});

test('쿼리 이름 키는 대소문자와 앞뒤 공백을 무시한다', () => {
  // query_registry 조회가 대소문자를 구분하지 않으므로(schema.sql이 collation을 고정한다)
  // 이름으로 판정하는 모든 곳이 같은 키를 봐야 한다
  assert.equal(nameKey('BATCH_JOB_STATUS'), nameKey('batch_job_status'));
  assert.equal(nameKey('  batch_job_status  '), 'batch_job_status');
  assert.equal(nameKey(null), '');
  assert.equal(nameKey(undefined), '');
});

test('짝 잃은 서로게이트는 앞·뒤·가운데 어디에 있든 제거된다', () => {
  // clipText는 '우리가 자른 경계'(끝의 상위 서로게이트)만 본다. 클라이언트가 이모지 한가운데를
  // 자르고 뒷조각을 보내면 맨 앞에 하위 서로게이트가 남는데, 그쪽은 그 검사를 통째로 비켜 간다 —
  // 그 문자열은 유효한 UTF-8이 아니라 LLM 요청이 거부되거나 본문이 U+FFFD로 훼손된다.
  assert.equal(stripLoneSurrogates('\uDC00abc'), 'abc', '앞의 하위 서로게이트');
  assert.equal(stripLoneSurrogates('abc\uD800'), 'abc', '뒤의 상위 서로게이트');
  assert.equal(stripLoneSurrogates('a\uD800b\uDC00c'), 'abc', '가운데에 낀 조각들');
  // 온전한 쌍은 절대 건드리지 않는다
  assert.equal(stripLoneSurrogates('ab\u{1F600}c'), 'ab\u{1F600}c');
  assert.equal(stripLoneSurrogates('평범한 한글'), '평범한 한글');
  assert.ok(stripLoneSurrogates('\uDC00 재시작은 어떻게 해?').isWellFormed());
});

test('정수 환경변수는 16진수·지수 표기를 통과시키지 않는다', () => {
  // Number()는 '0x50'→80, '1e10'→10000000000을 조용히 받아주고 그 값은 정수라 검사도 통과한다 —
  // ORACLE_TIMEOUT_MS=1e10이면 callTimeout이 약 116일이 되어 사실상 타임아웃이 사라지는데
  // 경고 한 줄 남지 않는다. 이 파서의 존재 이유가 그런 오타를 소리 나게 만드는 것이다.
  const warned = [];
  const origWarn = console.warn;
  console.warn = m => warned.push(String(m));
  try {
    for (const raw of ['0x50', '1e5', '1e10', '3.5', 'abc', '-1']) {
      process.env.NUMENV_TEST = raw;
      warned.length = 0;
      assert.equal(numEnv('NUMENV_TEST', 7), 7, raw);
      assert.ok(warned.some(m => /NUMENV_TEST/.test(m)), `경고가 없다: ${raw}`);
    }
    // 정상 표기는 그대로 통과한다 (앞뒤 공백은 흡수)
    for (const [raw, want] of [['80', 80], [' 42 ', 42], ['+3', 3]]) {
      process.env.NUMENV_TEST = raw;
      assert.equal(numEnv('NUMENV_TEST', 7), want, raw);
    }
    // 0은 allowZero일 때만 (PORT=0, EMBED_SYNC_INTERVAL=0은 의도된 값이다)
    process.env.NUMENV_TEST = '0';
    assert.equal(numEnv('NUMENV_TEST', 7), 7);
    assert.equal(numEnv('NUMENV_TEST', 7, { allowZero: true }), 0);
    // 미설정·빈 값은 경고 없이 기본값
    delete process.env.NUMENV_TEST;
    warned.length = 0;
    assert.equal(numEnv('NUMENV_TEST', 7), 7);
    process.env.NUMENV_TEST = '  ';
    assert.equal(numEnv('NUMENV_TEST', 7), 7);
    assert.equal(warned.length, 0, '미설정은 오타가 아니므로 조용해야 한다');
  } finally {
    console.warn = origWarn;
    delete process.env.NUMENV_TEST;
  }
});

test('바인드 값 조회는 소유 키만 보되 대소문자는 무시한다', () => {
  // 판정(agent.js paramKey)·실행(oracle.js runQuery)이 공유하는 단일 지점이다.
  // 대소문자를 가리면 모델이 값을 제대로 채워도 '값 없음'이 되고(Oracle은 :job_id와 :JOB_ID를
  // 같은 바인드로 다룬다), 프로토타입 체인을 타면 '값 없음'이어야 할 자리가 다른 값으로 굳는다.
  assert.equal(bindValue({ JOB_ID: 'B1' }, 'job_id'), 'B1');
  assert.equal(bindValue({ job_id: 'B1' }, 'JOB_ID'), 'B1');
  // 정확히 일치하는 키가 우선이다
  assert.equal(bindValue({ JOB_ID: 'upper', job_id: 'exact' }, 'job_id'), 'exact');
  // 없는 값은 없는 채로 남아야 한다 (관대해진 판정이 '값 없음'을 삼키면 안 된다)
  assert.equal(bindValue({ other: 'x' }, 'job_id'), undefined);
  assert.equal(bindValue(undefined, 'job_id'), undefined);
  assert.equal(bindValue({ job_id: null }, 'job_id'), null, 'NULL은 값 없음과 구분된다');
  // 프로토타입 멤버는 돌려주지 않는다
  assert.equal(bindValue({}, '__proto__'), undefined);
  assert.equal(bindValue({}, 'toString'), undefined);
  assert.equal(bindValue(Object.fromEntries([['__proto__', 'V1']]), '__proto__'), 'V1');
});

test('경고 억제 scope에는 바뀌는 값을 담지 않는다', () => {
  // warnOnce는 scope별로 '마지막 문구'만 기억한다 — 한 scope에 성격이 다른 경고 둘이 들어오면
  // 문구가 번갈아 바뀌며 억제가 한 번도 걸리지 않는다. 실제로 두 곳이 그 상태였다:
  //   setup — LLM_PROVIDER와 ORACLE_MOCK 오타가 겹치면 요청마다 두 줄씩 무한히 쌓였다.
  //   search-like — 요청 하나가 세 테이블을 검색하므로 테이블명이 든 문구가 계속 번갈아 들어왔다.
  // 어느 쪽도 기능은 폴백으로 정상 동작해서, 증상이 '로그가 터진다'뿐이라 원인이 보이지 않는다.
  const warned = [];
  const origWarn = console.warn;
  console.warn = m => warned.push(String(m));
  try {
    for (let i = 0; i < 5; i++) {
      warnOnce('a', 'A가 죽었다');
      warnOnce('b', 'B가 죽었다');
    }
    assert.equal(warned.length, 2, `scope가 나뉘어 있으면 각각 1회여야 한다: ${warned.join(' / ')}`);
    // 같은 scope 안에서 오류의 '성격'이 바뀌면 반드시 다시 알린다 (억제의 존재 이유가 아니다)
    warnOnce('a', 'A가 다른 이유로 죽었다');
    assert.equal(warned.length, 3);
  } finally {
    console.warn = origWarn;
  }
});

test('조회대상 DB 목록을 프롬프트와 실행기가 같게 읽는다', () => {
  // 이 파서가 유일한 해석 지점이다 — 프롬프트(llm-openai dbList)와 실행 경계(oracle resolveTargetDb)가
  // 다르게 읽으면 '목록에 보였는데 실행이 모르는 이름이라고 거부하는' 후보가 생기고,
  // 그 실패는 모델이 보인 대로 답했는데도 나므로 고칠 방법이 없다.
  assert.deepStrictEqual(targetDbNames('ORDER_DB'), ['ORDER_DB']);
  assert.deepStrictEqual(targetDbNames('A;B;C'), ['A', 'B', 'C']);
  // 사람이 손으로 적는 값이다 — 공백과 빈 조각은 흔하고, 뜻이 달라지지 않는다.
  assert.deepStrictEqual(targetDbNames(' A ; B '), ['A', 'B']);
  assert.deepStrictEqual(targetDbNames('A;;B;'), ['A', 'B']);
  // 빈 이름이 후보로 올라가면 loadTargetDb가 0건을 돌려주고, 실패는 '접속 정보 미등록'으로
  // 보고되어 원인이 세미콜론 하나라는 사실을 어디에서도 가리키지 않는다.
  assert.deepStrictEqual(targetDbNames(''), []);
  assert.deepStrictEqual(targetDbNames(null), []);
  assert.deepStrictEqual(targetDbNames(';;'), []);
  // target_db 조회는 대소문자를 무시하는 collation이라 'A;a'는 한 개다 —
  // 둘로 세면 프롬프트가 같은 DB를 두 번 보여주며 모델에게 '고를 것이 둘'이라고 말한다.
  assert.deepStrictEqual(targetDbNames('A;a;A'), ['A']);
  assert.deepStrictEqual(targetDbNames('DB1;db1'), ['DB1']);
});
