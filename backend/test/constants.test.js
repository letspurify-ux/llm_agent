// 공유 헬퍼 회귀 테스트 — 실행: npm test
// clipText/nameKey는 절단과 이름 비교가 일어나는 모든 곳(프롬프트·임베딩·조회 셀·루프 가드·mock)이
// 함께 쓴다. 여기가 어긋나면 어긋난 티가 나지 않는 자리에서 조용히 갈라진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { clipText, nameKey, stripLoneSurrogates, numEnv } from '../src/constants.js';

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
