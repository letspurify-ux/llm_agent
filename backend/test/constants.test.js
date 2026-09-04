// 공유 헬퍼 회귀 테스트 — 실행: npm test
// clipText/nameKey는 절단과 이름 비교가 일어나는 모든 곳(프롬프트·임베딩·조회 셀·루프 가드·mock)이
// 함께 쓴다. 여기가 어긋나면 어긋난 티가 나지 않는 자리에서 조용히 갈라진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { clipText, nameKey, stripLoneSurrogates, numEnv, bindValue, warnOnce, targetDbNames, joinUrl, isPlainObject,
  readCapped, MAX_UPSTREAM_JSON_BYTES, MAX_COMPLETION_TOKENS } from '../src/constants.js';

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

test('base URL 끝의 슬래시 유무가 요청 경로를 바꾸지 않는다', () => {
  // .env.example은 `…/v1`이지만 `…/v1/`로 적는 사람도 많다 — 그대로 이으면 `//chat/completions`가
  // 되어 경로를 엄격히 대조하는 프록시에서 404가 나고, 화면에는 'LLM 호출 실패'만 남는다.
  assert.equal(joinUrl('http://h/v1', 'chat/completions'), 'http://h/v1/chat/completions');
  assert.equal(joinUrl('http://h/v1/', 'chat/completions'), 'http://h/v1/chat/completions');
  assert.equal(joinUrl('http://h/v1//', 'embeddings'), 'http://h/v1/embeddings');
  // 미설정은 그대로 흘려보낸다 — 여기서 던지지 않고 fetch의 URL 파싱 오류로 실패하게 둔다
  assert.equal(joinUrl(undefined, 'chat/completions'), '/chat/completions');
});

test('키-값 객체 판정은 배열·null·문자열을 통과시키지 않는다', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  for (const v of [[], ['a'], null, undefined, 'a=b', 7, true]) assert.equal(isPlainObject(v), false, String(v));
});

// 끝없이 쏟아내는 상대. 몇 조각까지 실제로 받아갔는지 세어 둔다 — '상한을 넘으면 던진다'만으로는
// 다 받아 놓고 던지는 것과 구분되지 않는데, 자원의 관점에서는 그 둘이 정반대다.
function 쏟아내는_응답(조각크기, 최대조각 = Infinity) {
  const 센것 = { 보낸조각: 0 };
  const body = new ReadableStream({
    pull(c) {
      if (센것.보낸조각 >= 최대조각) { c.close(); return; }
      센것.보낸조각++;
      c.enqueue(new Uint8Array(조각크기));
    },
  });
  return { res: { body }, 센것 };
}

test('상류 응답은 상한 안에서만 읽고, 넘으면 그 자리에서 끊는다', async () => {
  // 이 시스템의 다른 I/O 경계에는 전부 예산이 있다(질문 1MB·행 수·셀 길이·프롬프트 총량·시간 상한).
  // 상류가 돌려주는 본문만 res.json()으로 통째로 받고 있었다 — 그러면 상한을 정하는 것은 우리가
  // 아니라 상대다 (확인: 64MB 응답 한 건에 백엔드 RSS가 86MB → 365MB로 올랐다).
  assert.equal(await readCapped(new Response('{"a":1}'), 1024, 'LLM'), '{"a":1}');
  // 정확히 상한까지는 받는다 (경계에서 멀쩡한 응답을 버리지 않게)
  assert.equal((await readCapped(new Response('abcde'), 5, 'LLM')).length, 5);

  const { res, 센것 } = 쏟아내는_응답(64 * 1024);   // 끝나지 않는 본문
  await assert.rejects(() => readCapped(res, 256 * 1024, 'LLM'), e => {
    assert.match(e.message, /LLM 응답이 상한/);
    // 같은 입력에 같은 응답이 돌아오므로 재시도 대상이 아니다 — 부르는 쪽이 이 표시로 가른다
    // (embedding.js의 retriable).
    assert.equal(e.tooLarge, true);
    return true;
  });
  // 다 받아 놓고 던진 것이 아니라 넘긴 그 자리에서 끊었는가. 상한 256KB / 조각 64KB이므로
  // 다섯 조각이면 넘고, 스트림이 한 조각 앞서 당겨 오는 몫까지 봐도 여섯이다.
  assert.ok(센것.보낸조각 <= 6, `상한을 넘긴 뒤에도 계속 받았다: ${센것.보낸조각}조각`);
});

test('본문 스트림이 없는 응답은 text()로 물러선다', async () => {
  // 실제 fetch는 언제나 본문 스트림을 준다 — 이 길은 스텁(테스트 더블)을 위한 것이고,
  // 그 더블이 상한을 지나지 않는다는 사실이 여기 적혀 있어야 한다.
  assert.equal(await readCapped({ text: async () => 'x' }, 1, 'LLM'), 'x');
});

test('상류 응답 상한은 완성 토큰 상한보다 넉넉하다', () => {
  // 상한에 걸리는 응답은 '우리가 요청한 것이 아니다'가 이 값의 근거다. 한 토큰이 최악으로 길고
  // (한글 3바이트 남짓) JSON 이스케이프까지 겹쳐도 요청한 완성은 이 값 안에 들어야 한다 —
  // 그러지 않으면 정상 답변이 상한에 걸려 모든 질문이 'LLM 호출 실패'로 끝난다.
  assert.ok(MAX_UPSTREAM_JSON_BYTES > MAX_COMPLETION_TOKENS * 3 * 6,
    `완성 상한(${MAX_COMPLETION_TOKENS}토큰)에 비해 응답 상한이 빠듯하다: ${MAX_UPSTREAM_JSON_BYTES}`);
});

test('clipText: 음수 상한은 아무것도 남기지 않는다 — 상한보다 긴 글자를 돌려주지 않는다', () => {
  // slice(0, -1)은 뒤에서 세므로, 가드가 없으면 '길이를 묶으라고 부른 함수'가 거의 원문을 돌려준다
  // (실측: clipText('abcdef', -1) === 'abcde'). 상한 계산이 한 번 음수로 떨어지면 이 파일의 예산이
  // 전부 조용히 무의미해지는 자리라, 부르는 쪽의 기억이 아니라 여기서 보장한다.
  // 같은 규칙을 적어 둔 프런트(frontend/src/chart.js sliceSafe)는 이미 이 경계를 지킨다.
  for (const max of [-1, -3, -100]) assert.strictEqual(clipText('abcdef', max), '');
  // 0과 양수는 지금까지 그대로다
  assert.strictEqual(clipText('abcdef', 0), '');
  assert.strictEqual(clipText('', 0), '');
  assert.strictEqual(clipText('abcdef', 2), 'ab');
  assert.strictEqual(clipText('abc', 10), 'abc');
  // 어떤 상한에서도 결과는 상한 이하이고 원문의 접두다
  for (let max = -5; max <= 12; max++) {
    const r = clipText('a😀b가c😀', max);
    assert.ok(r.length <= Math.max(0, max), `상한 ${max}인데 ${r.length}자`);
    assert.ok('a😀b가c😀'.startsWith(r), `접두가 아니다: ${JSON.stringify(r)}`);
  }
});
