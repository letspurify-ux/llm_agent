// 결정 루프 가드 회귀 테스트 — 실행: npm test
// 이 판정은 양쪽 방향 모두로 '조용히' 깨진다.
//   느슨해지면 — 퇴화한 LLM 응답이 제자리를 돌며 스텝과 Oracle 조회를 소진한다.
//   빡빡해지면 — 다단계 절차의 정상 흐름이 '이미 실행된 쿼리'로 끊겨 답변만 부실해진다.
// 어느 쪽도 오류를 남기지 않아 로그로는 알 수 없다. 테스트가 유일한 방어선이다.
import { test } from 'node:test';
import assert from 'node:assert';
import { loopGuard, paramKey, normalizeChat, fallbackAnswer } from '../src/agent.js';
import { MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_ANSWER_LEN, MAX_RESULT_ROWS, MAX_RESULT_COLS } from '../src/constants.js';

const ran = (name, params, rows = [{ A: 1 }]) => ({ query_name: name, params, rows, totalRows: rows.length });
const failed = (name, params) => ({ query_name: name, params, error: 'ORA-00942' });
const BINDS = ['job_id'];

test('같은 쿼리·같은 파라미터의 재실행을 막는다', () => {
  const history = [ran('batch_job_status', { job_id: 'B1' })];
  assert.match(loopGuard(history, 'batch_job_status', BINDS, { job_id: 'B1' }), /이미 같은 파라미터/);
});

test('파라미터가 다르면 통과시킨다', () => {
  // 다단계 절차는 같은 쿼리를 다른 값으로 다시 부른다 — 여기서 막으면 정상 흐름이 끊긴다.
  const history = [ran('batch_job_status', { job_id: 'B1' })];
  assert.equal(loopGuard(history, 'batch_job_status', BINDS, { job_id: 'B2' }), null);
});

test('이름 비교는 대소문자·앞뒤 공백을 무시한다', () => {
  // query_registry는 대소문자를 구분하지 않는 collation이다 — ===로 보면 철자만 다른 같은 쿼리를
  // '아직 실행 안 함'으로 읽고 매 스텝 다시 실행한다.
  const history = [ran('BATCH_JOB_STATUS', { job_id: 'B1' })];
  assert.match(loopGuard(history, '  batch_job_status ', BINDS, { job_id: 'B1' }), /이미 같은 파라미터/);
});

test('SQL에 없는 여분 파라미터는 다른 실행으로 보지 않는다', () => {
  // runQuery가 SQL의 바인드만 추려 쓰므로 여분 키가 붙었다고 다른 조회가 되지는 않는다.
  const history = [ran('batch_job_status', { job_id: 'B1' })];
  assert.match(loopGuard(history, 'batch_job_status', BINDS, { job_id: 'B1', 잡소리: 'x' }), /이미 같은 파라미터/);
});

test('숫자와 문자열은 같은 바인드 값이다', () => {
  const history = [ran('q', { id: 1 })];
  assert.match(loopGuard(history, 'q', ['id'], { id: '1' }), /이미 같은 파라미터/);
});

test('null·undefined·문자열 "null"을 구분한다', () => {
  // String(null) === 'null'이라 정규화가 허술하면 셋이 한 값으로 뭉개진다.
  const keys = [
    paramKey(['a'], { a: null }),
    paramKey(['a'], { a: undefined }),
    paramKey(['a'], { a: 'null' }),
  ];
  assert.equal(new Set(keys).size, 3, `구분되지 않았다: ${keys.join(' / ')}`);
});

test('키 순서가 달라도 같은 실행으로 본다', () => {
  assert.equal(paramKey(null, { b: 2, a: 1 }), paramKey(null, { a: 1, b: 2 }));
});

test('쉼표가 든 키가 순서 판정을 흔들지 않는다', () => {
  // 비교 함수 없는 sort는 [k,v]를 이어붙인 문자열을 기준으로 삼아 입력 순서에 좌우된다.
  assert.equal(paramKey(null, { 'a,z': 1, b: 2 }), paramKey(null, { b: 2, 'a,z': 1 }));
});

test('프로토타입 멤버와 겹치는 바인드명이 실행 판정을 어긋내지 않는다', () => {
  // params?.['__proto__']가 값 대신 Object.prototype을 돌려주면 '값 없음'이 다른 문자열로 굳어,
  // 같은 '값 없음' 상태 둘이 서로 다른 실행으로 보인다 — 가드가 그 경로에서만 무력해진다.
  // 실행 경계(oracle.js)와 Mock(llm.js)이 이미 소유 키 기준인데 여기만 체인을 타고 있었다.
  assert.equal(paramKey(['__proto__'], {}), paramKey(['__proto__'], undefined));
  assert.equal(paramKey(['toString'], {}), paramKey(['toString'], { other: 1 }));
  // 반대 방향 — 실제로 채워진 값은 '값 없음'과 구분되어야 한다
  assert.notEqual(paramKey(['__proto__'], Object.fromEntries([['__proto__', 'V1']])), paramKey(['__proto__'], {}));
  assert.notEqual(paramKey(['toString'], { toString: 'x' }), paramKey(['toString'], {}));
});

test('값이 아닌 구조는 서로 다른 실행으로 구분된다', () => {
  // String(v)는 모든 객체를 '[object Object]'로 낮춘다 — 서로 다른 두 결정이 한 실행으로 뭉개져,
  // 값이 아닌 구조를 두 번 준 응답의 두 번째가 '이미 실행했다'로 처리된다.
  // 그러면 MAX_GUARD_HITS가 실제보다 한 스텝 일찍 차서 모델이 값을 고쳐 잡을 기회를 잃는다.
  assert.notEqual(paramKey(['a'], { a: { x: 1 } }), paramKey(['a'], { a: { y: 2 } }));
  assert.notEqual(paramKey(['a'], { a: [1] }), paramKey(['a'], { a: [2] }));
  assert.notEqual(paramKey(['a'], { a: { x: 1 } }), paramKey(['a'], { a: '[object Object]' }));
  // 같은 구조는 키 순서가 달라도 같은 실행이다 (최상위 키 순서를 정규화하는 것과 같은 이유)
  assert.equal(paramKey(['a'], { a: { x: 1, y: 2 } }), paramKey(['a'], { a: { y: 2, x: 1 } }));
  // 순환 참조가 가드를 죽이면 안 된다 — 판정 하나가 결정 루프 전체를 끊는다.
  // '던지지 않는다'만으로는 부족하다: 정규화를 JSON.stringify의 replacer로 하면 매번 새 객체를
  // 돌려주게 되어 순환 탐지가 통째로 비켜가고(원본이 직렬화 스택에 오르지 않는다), 스택이
  // 바닥날 때까지 재귀한 뒤 RangeError가 catch에 잡힌다 — 겉으로는 통과하지만 그 자리에서
  // 자바스크립트 스택을 전부 태우고 값은 '[object Object]'로 뭉개진다.
  // 그래서 '순환 구조 둘이 여전히 구분되는가'로 잰다 — 뭉개지면 이 단언이 깨진다.
  const cyclic = { x: 1 };
  cyclic.self = cyclic;
  const cyclic2 = { x: 2 };
  cyclic2.self = cyclic2;
  assert.doesNotThrow(() => paramKey(['a'], { a: cyclic }));
  assert.notEqual(paramKey(['a'], { a: cyclic }), paramKey(['a'], { a: cyclic2 }));
  // 순환이 아닌 '공유 참조'를 순환으로 오판하면 안 된다 (seen에서 되빼지 않으면 그렇게 된다)
  const shared = { s: 1 };
  assert.equal(
    paramKey(['a'], { a: { p: shared, q: shared } }),
    paramKey(['a'], { a: { p: { s: 1 }, q: { s: 1 } } })
  );
});

test('바인드명 대소문자가 실행 판정을 어긋내지 않는다', () => {
  // Oracle의 바인드명은 대소문자를 구분하지 않아 실행 경계가 :job_id에 {"JOB_ID": …}를 바인드한다.
  // 판정이 그 규칙을 따르지 않으면, 표기만 바꿔 같은 조회를 반복하는 퇴화가 매번 '다른 실행'으로
  // 통과한다 — 조회는 성공하므로 오류도 남지 않는다.
  assert.equal(paramKey(BINDS, { JOB_ID: 'B1' }), paramKey(BINDS, { job_id: 'B1' }));
  assert.notEqual(paramKey(BINDS, { JOB_ID: 'B1' }), paramKey(BINDS, { job_id: 'B2' }));
  // 미등록 쿼리(바인드를 알 수 없는 경우)도 같은 기준으로 본다
  assert.equal(paramKey(null, { JOB_ID: 'B1' }), paramKey(null, { job_id: 'B1' }));
  // 가드까지 이어져야 의미가 있다
  assert.match(
    loopGuard([ran('batch_job_status', { JOB_ID: 'B1' })], 'batch_job_status', BINDS, { job_id: 'B1' }),
    /이미 같은 파라미터/
  );
});

test('첫 실패는 재시도를 허용하고 반복 실패만 막는다', () => {
  // 1회 실패는 일시 오류일 수 있다. 여기서 바로 막으면 복구 가능한 조회가 영영 죽는다.
  assert.equal(loopGuard([failed('q', { job_id: 'B1' })], 'q', BINDS, { job_id: 'B1' }), null);
  assert.match(
    loopGuard([failed('q', { job_id: 'B1' }), failed('q', { job_id: 'B1' })], 'q', BINDS, { job_id: 'B1' }),
    /반복 실패/
  );
});

test('0건 성공도 실행으로 센다', () => {
  // rows는 성공 시 빈 배열이라도 존재한다 — length로 판정하면 '없음'을 확인하려고 무한 재실행한다.
  const history = [ran('q', { job_id: 'B1' }, [])];
  assert.match(loopGuard(history, 'q', BINDS, { job_id: 'B1' }), /이미 같은 파라미터/);
});

test('제어용 note 기록은 실행으로도 실패로도 세지 않는다', () => {
  const history = [{ query_name: 'q', params: { job_id: 'B1' }, note: '이미 …' }];
  assert.equal(loopGuard(history, 'q', BINDS, { job_id: 'B1' }), null);
});

test('바인드를 모르는 미등록 쿼리는 원본 파라미터로 비교한다', () => {
  // 미등록 이름의 반복이 가장 흔한 퇴화 패턴이라 이 경로도 반드시 걸려야 한다.
  const history = [failed('없는쿼리', { x: 1 }), failed('없는쿼리', { x: 1 })];
  assert.match(loopGuard(history, '없는쿼리', null, { x: 1 }), /반복 실패/);
  assert.equal(loopGuard(history, '없는쿼리', null, { x: 2 }), null);
});

test('클라이언트 대화 이력은 형식·턴 수·길이를 모두 제한한다', () => {
  const dirty = [
    { role: 'system', text: '무시돼야 한다' },
    { role: 'user' },                       // text 없음
    { role: 'user', text: 42 },             // 문자열 아님
    null,
    ...new Array(10).fill({ role: 'user', text: 'x'.repeat(MAX_CHAT_LEN + 50) }),
  ];
  const out = normalizeChat(dirty);
  assert.equal(out.length, MAX_CHAT_TURNS);
  assert.ok(out.every(m => m.text.length === MAX_CHAT_LEN));
  assert.ok(out.every(m => m.role === 'user' || m.role === 'assistant'));
  assert.deepStrictEqual(normalizeChat('배열이 아님'), []);
  assert.deepStrictEqual(normalizeChat(undefined), []);
});

test('이력 절단이 서로게이트 쌍을 쪼개지 않는다', () => {
  // 상한 경계가 이모지 한가운데 걸리면 단순 slice는 짝 잃은 상위 서로게이트를 남긴다 —
  // 그 문자열은 LLM API로 보내는 인코딩 단계에서 U+FFFD로 조용히 훼손된다 (constants.clipText와 같은 불변식).
  const [cut] = normalizeChat([{ role: 'user', text: 'a'.repeat(MAX_CHAT_LEN - 1) + '😀' }]);
  assert.equal(cut.text, 'a'.repeat(MAX_CHAT_LEN - 1));

  // 클라이언트가 자기 쪽 절단에서 이미 쪼개 보낸 문자열(상한 이하)도 끝의 짝 잃은 서로게이트를 뗀다.
  const [preSplit] = normalizeChat([{ role: 'user', text: 'ab\ud83d' }]);
  assert.equal(preSplit.text, 'ab');
});

// 이력의 잘린 셀에서 마크만 떼고 옮겨 적은 값에 대한 가드는 여기 없다 —
// 그 앞부분의 길이는 반드시 clipText가 남기는 절단 길이이므로 oracle.js bindProblem이
// Oracle 접속 전에 같은 문구로 이미 거부한다 (그쪽 isClippedLen 주석과 test/oracle.test.js 참고).

test('내용이 빈 대화 턴은 프롬프트에 실리지 않는다', () => {
  // 빈 턴은 '- 사용자: ' 한 줄로 실려 모델이 내용 없는 발화를 맥락으로 읽는다.
  assert.deepStrictEqual(
    normalizeChat([
      { role: 'user', text: '' },
      { role: 'user', text: '   ' },
      { role: 'assistant', text: '\n\t' },
      { role: 'user', text: '실제 질문' },
    ]),
    [{ role: 'user', text: '실제 질문' }]
  );

  // 빈 판정은 trim으로 하면서 저장은 원본으로 하면, 공백이 그대로 프롬프트에 실리고
  // ('- 사용자:   BATCH001 상태  ') 턴 길이 예산(MAX_CHAT_LEN)까지 함께 먹는다.
  // 현재 질문은 서버 입력 검증이 같은 처리를 한다 — 이력만 빠져 있었다.
  assert.deepStrictEqual(
    normalizeChat([{ role: 'user', text: '  BATCH001 상태  ' }]),
    [{ role: 'user', text: 'BATCH001 상태' }]
  );
  const [budget] = normalizeChat([{ role: 'user', text: `${' '.repeat(100)}${'x'.repeat(MAX_CHAT_LEN)}` }]);
  assert.equal(budget.text, 'x'.repeat(MAX_CHAT_LEN), '공백이 본문 몫을 대신 먹었다');

  // 절단 뒤에 비는 경우도 걸러야 한다 — 짝 잃은 상위 서로게이트 하나뿐인 턴은
  // clipChatText가 그 코드유닛을 떼면서 빈 문자열이 된다 (앞에서만 거르면 이 경로로 남는다).
  assert.deepStrictEqual(normalizeChat([{ role: 'user', text: '\ud83d' }]), []);

  // 빈 턴이 턴 예산 자리를 차지하지 않는다 — 정상 턴이 상한만큼 그대로 남아야 한다.
  const mixed = [];
  for (let i = 0; i < MAX_CHAT_TURNS; i++) {
    mixed.push({ role: 'user', text: '' }, { role: 'user', text: `질문${i}` });
  }
  assert.deepStrictEqual(
    normalizeChat(mixed).map(m => m.text),
    Array.from({ length: MAX_CHAT_TURNS }, (_, i) => `질문${i}`)
  );
});

// ===== LLM이 끝내 결정을 내지 못했을 때 (fallbackAnswer) =====
// 두 방향으로 조용히 깨진다: 표시 없이 조립해 내보내면 'LLM이 죽었다'가 화면에서도 chat_log에서도
// 사라지고(정상 답변과 글자 그대로 구분되지 않는다), 조립을 포기하면 이미 조회해둔 결과가 버려진다.

test('폴백 답변은 조립된 답이라는 사실을 함께 알린다', () => {
  const a = fallbackAnswer({
    knowledge: [{ title: '배치 재시작 방법', content: 'restart_batch.sh 를 실행한다' }],
    history: [],
  });
  assert.match(a, /^\*LLM 응답을 받지 못해/, 'LLM 실패가 화면에서 사라지면 안 된다');
  assert.match(a, /restart_batch\.sh/, '손에 든 지식·조회 결과는 그대로 살려야 한다');
});

test('조립할 것이 하나도 없으면 실패만 알린다', () => {
  const a = fallbackAnswer({ knowledge: [], history: [] });
  assert.match(a, /LLM 호출에 실패/);
  assert.ok(!a.includes('정리한 답변'), '조립한 것이 없는데 조립했다고 말하면 안 된다');
});

test('폴백 답변도 답변 상한 안에서 나간다', () => {
  // 이 답은 llm.decide를 거치지 않아 sanitizeDecision(MAX_ANSWER_LEN) 밖에 있었다 — 조립 재료가
  // 조회 결과(스텝 × 행 × 컬럼)와 지식 본문(TEXT 64KB)이라 정상 답변보다 오히려 커진다.
  // 실측 57만 자짜리 답변이 응답 본문과 chat_log.answer로 그대로 나갔다: 상한이 존재하는 이유로
  // constants.js가 지목한 바로 그 경로가 정작 그 상한 밖에 있었다.
  const rows = Array.from({ length: MAX_RESULT_ROWS }, (_, i) =>
    Object.fromEntries(Array.from({ length: MAX_RESULT_COLS }, (_, c) => [`C${c}`, `v${i}-${c}-`.repeat(20)]))
  );
  const a = fallbackAnswer({
    knowledge: [{ title: 'K', content: 'ㄱ'.repeat(60_000) }],
    history: Array.from({ length: 5 }, () => ({ query_name: 'q', rows, totalRows: rows.length })),
  });
  assert.ok(a.length <= MAX_ANSWER_LEN + 100, `상한을 넘겼다: ${a.length}`);
  assert.match(a, /^\*LLM 응답을 받지 못해/, 'LLM 실패 표시는 잘려 나가면 안 된다');
  assert.match(a, /생략했습니다/, '잘린 사실이 사용자에게 보여야 한다');
});

test('클라이언트가 쪼개 보낸 서로게이트 조각이 프롬프트로 새어 나가지 않는다', () => {
  // 프런트(App.jsx)도 자기 쪽에서 턴을 자른다. 이모지 한가운데가 잘리면 '앞조각'은 끝에 상위
  // 서로게이트가, '뒷조각'은 앞에 하위 서로게이트가 남는다. 끝만 검사하던 가드는 뒷조각을
  // 통째로 지나쳤다 — 그 문자열은 JSON.stringify를 통과하지만(\udc00) 유효한 UTF-8이 아니라서
  // LLM 엔드포인트가 요청을 거부하고, 그 대화의 이후 질문이 전부 'LLM 호출 실패'로 끝난다.
  const cases = [
    '\uDC00 재시작은 어떻게 해?',   // 뒷조각 (앞의 하위 서로게이트)
    '재시작은 어떻게 해? \uD83D',   // 앞조각 (뒤의 상위 서로게이트)
    '앞\uD800가운데\uDC00뒤',        // 조각 둘을 이어 붙인 입력
  ];
  for (const text of cases) {
    const [turn] = normalizeChat([{ role: 'user', text }]);
    assert.ok(turn, `내용이 있는 턴이 사라졌다: ${JSON.stringify(text)}`);
    assert.ok(turn.text.isWellFormed(), `짝 잃은 서로게이트가 남았다: ${JSON.stringify(turn.text)}`);
    JSON.parse(JSON.stringify({ t: turn.text })); // 직렬화·역직렬화가 훼손 없이 왕복해야 한다
  }
  // 온전한 이모지는 그대로 남는다 — 가드가 넓어져 정상 입력을 갉아먹으면 안 된다
  assert.equal(normalizeChat([{ role: 'user', text: '배포 완료 🎉' }])[0].text, '배포 완료 🎉');
  // 조각 하나뿐인 턴은 빈 턴이 되므로 걸러진다 (프롬프트에 '- 사용자: ' 한 줄만 남지 않게)
  assert.deepStrictEqual(normalizeChat([{ role: 'user', text: '\uDC00' }]), []);
});
