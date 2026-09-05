// 결정 루프 가드 회귀 테스트 — 실행: npm test
// 이 판정은 양쪽 방향 모두로 '조용히' 깨진다.
//   느슨해지면 — 퇴화한 LLM 응답이 제자리를 돌며 스텝과 Oracle 조회를 소진한다.
//   빡빡해지면 — 다단계 절차의 정상 흐름이 '이미 실행된 쿼리'로 끊겨 답변만 부실해진다.
// 어느 쪽도 오류를 남기지 않아 로그로는 알 수 없다. 테스트가 유일한 방어선이다.
import { test } from 'node:test';
import assert from 'node:assert';
import { loopGuard, paramKey, normalizeChat, fallbackAnswer, normalizeQuestion, clippedCopyDetector, answerOf, handleQuestion, searchKey, mergeFront } from '../src/agent.js';
import { MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_ANSWER_LEN, MAX_RESULT_ROWS, MAX_RESULT_COLS, MAX_CELL_LEN, TRUNC_MARK, MAX_STEPS, MAX_SEARCHES, MAX_HISTORY_ROWS, MAX_BATCH_QUERIES, MAX_EXPANDS, MAX_DOC_LEN, SEARCH_TARGETS } from '../src/constants.js';
import { buildPrompt } from '../src/llm-openai.js';
import { buildItems, planRanges, canGrow } from '../src/chunk.js';

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

// 이력의 잘린 셀에서 마크만 떼고 옮겨 적은 값을 거르는 판정 자체는 실행 경계에 있다
// (oracle.js bindProblem). 이 파일이 검증하는 것은 그 판정에 넘겨줄 '무엇을 잘랐는가'를
// 만드는 쪽이다 — 아래 clippedCopyDetector 테스트, 그리고 test/oracle.test.js.

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

test('질문 정규화는 서버 입력 검증과 같은 값을 만든다', () => {
  // 규칙이 두 곳에 각자 적혀 있었다: server.js는 서로게이트를 걷어낸 뒤 trim까지 했고
  // handleQuestion은 하지 않아, 같은 입력이 어느 문으로 들어오느냐에 따라 다른 질문이 됐다.
  // 짝 잃은 코드유닛은 유효한 UTF-8이 아니라서 LLM·임베딩 요청이 통째로 거부되거나
  // 본문이 U+FFFD로 조용히 훼손된다 (constants.stripLoneSurrogates 참고).
  assert.equal(normalizeQuestion('  BATCH001 상태  '), 'BATCH001 상태');
  assert.equal(normalizeQuestion('\uD83D 재시작은 어떻게 해?'), '재시작은 어떻게 해?');
  assert.equal(normalizeQuestion('\uDC00'), '');
  assert.equal(normalizeQuestion(undefined), '');
  // 멱등이어야 두 경계에서 모두 불러도 값이 갈라지지 않는다
  const once = normalizeQuestion(' a\uD83Db ');
  assert.equal(normalizeQuestion(once), once);
});

test('잘린 셀의 앞부분만 옮겨 적은 바인드 값을 걸러낸다', () => {
  // 모델은 잘린 셀을 보면 TRUNC_MARK를 뗀 앞부분만 옮겨 적는 일이 잦다. 그 값으로 조회하면
  // 반드시 0건이 나오고, 모델은 그 0건을 "그런 데이터가 없다"로 읽는다 — 오류가 한 줄도
  // 남지 않는 오답이다. 반대로 길이로 짐작하면 정당한 200자 입력을 영영 거부한다.
  const clipped = 'a'.repeat(MAX_CELL_LEN) + TRUNC_MARK;
  const prefix = 'a'.repeat(MAX_CELL_LEN);
  // 절단 경계가 서로게이트 쌍을 가르면 앞부분이 한 칸 짧다 — 길이가 몇이든 대조는 성립해야 한다
  const shortClipped = 'b'.repeat(MAX_CELL_LEN - 1) + TRUNC_MARK;
  const shortPrefix = 'b'.repeat(MAX_CELL_LEN - 1);

  const d = clippedCopyDetector([{ role: 'assistant', text: `| O-777 | ${shortClipped} |` }]);
  assert.equal(d.isCopy(prefix), false, '아직 조회하지 않았으면 이번 요청의 값은 모른다');
  assert.equal(d.isCopy(shortPrefix), true, '지난 턴 답변에 실렸던 앞부분은 대화 이력으로 잡는다');

  // 마크에 '붙어 있는' 문자열을 찾는 방식이면 마크 바로 앞의 짧고 정당한 값이 전부 걸린다.
  // 판정은 '값 전체가 우리가 자른 앞부분과 같은가'여야 한다 — 붙어 있는지가 아니라.
  for (let n = 1; n <= 60; n++) {
    const tail = shortPrefix.slice(-n);
    assert.equal(d.isCopy(tail), false, `마크 앞 ${n}자 조각은 잘린 조각이 아니다`);
  }
  assert.equal(d.isCopy(''), false, '빈 문자열이 걸리면 안 된다 (값 없음과 문구가 뒤바뀐다)');

  d.record([{ A: clipped, B: 'ok', C: null, D: 12345 }]);
  assert.equal(d.isCopy(prefix), true, '이번 요청에서 자른 셀의 앞부분');
  assert.equal(d.isCopy(clipped), false, '마크가 붙은 값은 bindProblem이 따로 본다');

  // 길이가 같아도 우리가 자른 적 없는 값은 통과해야 한다 — 이것이 길이 판정의 오탐이었다
  for (const v of ['x'.repeat(MAX_CELL_LEN), 'x'.repeat(MAX_CELL_LEN - 1), 'ok']) {
    assert.equal(d.isCopy(v), false, `자른 적 없는 값은 통과해야 한다 (${v.length}자)`);
  }
});

test('잘린 값 판정이 실행 경계와 이어져 있다', async () => {
  // 판정자를 만드는 곳(agent)과 쓰는 곳(oracle)이 갈라지면 가드가 통째로 무력해지는데,
  // 그 실패는 '조회가 0건'으로만 보여 오류를 남기지 않는다.
  const { runQuery } = await import('../src/oracle.js');
  process.env.ORACLE_MOCK = '1';
  const row = { query_name: 'batch_job_status', query_sql: 'SELECT 1 FROM T WHERE A = :job_id', target_db_name: 'D' };
  const clipped = 'a'.repeat(MAX_CELL_LEN) + TRUNC_MARK;
  const d = clippedCopyDetector([]);
  d.record([{ A: clipped }]);
  await assert.rejects(
    runQuery(row, { job_id: 'a'.repeat(MAX_CELL_LEN) }, d.isCopy),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
  // 같은 길이지만 자른 적 없는 값은 실행돼야 한다 (mock은 0건을 돌려줄 뿐)
  const r = await runQuery(row, { job_id: 'z'.repeat(MAX_CELL_LEN) }, d.isCopy);
  assert.deepStrictEqual(r.rows, []);
});

test('쓸 수 있는 답변인지는 두 답변 경로가 같은 함수로 판정한다', () => {
  // 답변이 나가는 경로가 둘이다(루프 안에서 답한 결정, 마지막 강제 답변). 한쪽만 판정을 가지면
  // 나머지 한쪽이 조용히 보호 밖에 남는다 — 실제로 그랬다. 결정 경계(llm.js sanitizeDecision)가
  // answer의 타입을 일부러 정규화하지 않으므로 falsy한 answer가 그대로 도달할 수 있고,
  // 그러면 빈 말풍선이 화면에 뜨고 그 빈 턴이 다음 질문의 맥락으로 되돌아온다.
  assert.equal(answerOf({ action: 'answer', answer: '정상 답변' }), '정상 답변');
  for (const bad of ['', 0, null, undefined, false, NaN]) {
    assert.equal(answerOf({ action: 'answer', answer: bad }), null, `falsy answer는 폴백으로 (${JSON.stringify(bad)})`);
  }
  assert.equal(answerOf({ action: 'run_query', query_name: 'q' }), null, '조회 결정은 답변이 아니다');
  assert.equal(answerOf(null), null);
  assert.equal(answerOf(undefined), null);
});

test('대상 DB가 다르면 같은 쿼리·같은 파라미터라도 다른 실행이다', () => {
  // 대상 DB가 여럿인 쿼리에서 이 구분이 없으면 '서울 재고를 보고 이어서 부산 재고를 본다'는
  // 정상 흐름이 '이미 같은 파라미터로 실행된 쿼리'로 끊긴다 — 이름도 바인드도 같고 다른 것은
  // DB뿐이기 때문이다. 두 번째 DB는 영영 조회되지 않는데 남는 기록은 note 한 줄뿐이라,
  // 모델은 조회한 적 없는 DB에 대해 '이미 실행됨'이라는 안내를 받는다.
  const seoul = { ...ran('stock', { item: 'A' }), targetDb: 'SEOUL' };
  assert.equal(loopGuard([seoul], 'stock', ['item'], { item: 'A' }, 'BUSAN'), null);
  assert.match(loopGuard([seoul], 'stock', ['item'], { item: 'A' }, 'SEOUL'), /이미 같은 파라미터/);
  // 이력에는 성공 기록의 등록 철자와 실패 기록의 요청 철자가 섞인다 — 비교는 nameKey로 한다.
  assert.match(loopGuard([seoul], 'stock', ['item'], { item: 'A' }, ' seoul '), /이미 같은 파라미터/);
});

test('반복 실패 판정도 대상 DB별로 따로 센다', () => {
  // DB를 보지 않으면 서울에서 두 번 실패한 것만으로 부산 조회가 '반복 실패'로 막힌다.
  const fail = db => ({ ...failed('stock', { item: 'A' }), targetDb: db });
  const history = [fail('SEOUL'), fail('SEOUL')];
  assert.match(loopGuard(history, 'stock', ['item'], { item: 'A' }, 'SEOUL'), /반복 실패/);
  assert.equal(loopGuard(history, 'stock', ['item'], { item: 'A' }, 'BUSAN'), null);
});

// ===== 결정 루프 — 검색 행동 =====
// 검색은 모델이 요청할 때만 일어난다. 이 루프의 판정은 loopGuard와 같은 부류다: 느슨하면 같은 검색으로
// 제자리를 돌고, 빡빡하면 정당한 재검색이 막힌다. 어느 쪽도 오류를 남기지 않으므로 DB·LLM 없이 스텁으로 잰다.
const ALL = [...SEARCH_TARGETS];
const K = (seq, title = `지식${seq}`) => ({ seq, title, content: `${title} 본문` });
const Q = (seq, name) => ({ seq, query_name: name, query_sql: 'SELECT 1 FROM t WHERE a = :a', target_db_name: 'D' });

// 결정을 순서대로 내는 LLM 스텁. 받은 ctx를 기록해 '모델이 무엇을 보았는가'를 잴 수 있게 한다.
function scripted(decisions) {
  const seen = [];
  const decide = async ctx => {
    seen.push({ ...ctx, knowledge: [...ctx.knowledge], qaMethods: [...ctx.qaMethods], queries: [...ctx.queries], history: [...ctx.history] });
    if (ctx.forceAnswer) return { action: 'answer', answer: '강제 답변' };
    return decisions.shift() ?? { action: 'answer', answer: '기본 답변' };
  };
  return { decide, seen };
}
const found = over => ({ knowledge: undefined, qaMethods: undefined, queries: undefined, routed: null, queriesFailed: false, directFailed: false, ...over });
const silence = () => { const orig = console.log; console.log = () => {}; return () => { console.log = orig; }; };

test('인사는 검색 없이 LLM 호출 한 번으로 끝난다', async () => {
  const restore = silence();
  try {
    const llm = scripted([{ action: 'answer', answer: '안녕하세요!' }]);
    let searchedTimes = 0;
    const r = await handleQuestion('안녕', [], { deps: { decide: llm.decide, search: async () => { searchedTimes++; return found(); } } });
    assert.equal(r.answer, '안녕하세요!');
    assert.equal(searchedTimes, 0, '인사에 검색이 돌았다');
    assert.deepStrictEqual(r.trace, []);
    assert.equal(r.search.searches, 0);
    assert.deepStrictEqual(r.search.targets, { knowledge: 0, qa_method: 0, query: 0 });
    assert.equal(r.search.knowledge, null, '찾아보지 않은 대상은 0이 아니라 null이다');
    assert.equal(r.timing.llm.length, 1, 'LLM 호출이 한 번이어야 한다');
    // 첫 호출의 컨텍스트는 비어 있고 아무것도 찾아보지 않은 상태다
    assert.deepStrictEqual(llm.seen[0].searched, []);
  } finally { restore(); }
});

test('검색 결정은 요청한 대상만 찾고, 결과가 다음 호출의 컨텍스트에 실린다', async () => {
  const restore = silence();
  try {
    const llm = scripted([{ action: 'search', text: '배치 재시작', targets: ['knowledge'] }, { action: 'answer', answer: '답' }]);
    const calls = [];
    const search = async (text, targets) => { calls.push([text, targets]); return found({ knowledge: [K(1), K(2)] }); };
    const r = await handleQuestion('배치 재시작 방법 알려줘', [], { deps: { decide: llm.decide, search } });
    assert.deepStrictEqual(calls, [['배치 재시작', ['knowledge']]]);
    assert.deepStrictEqual(r.trace, [{ search: '배치 재시작', targets: ['knowledge'], hits: { knowledge: 2, qaMethods: null, queries: null } }]);
    const second = llm.seen[1];
    assert.deepStrictEqual(second.knowledge.map(k => k.seq), [1, 2]);
    assert.deepStrictEqual(second.searched, ['knowledge']);
    assert.deepStrictEqual(r.search, { searches: 1, targets: { knowledge: 1, qa_method: 0, query: 0 }, knowledge: 2, qaMethods: null, queries: null });
    assert.equal(r.timing.search.length, 1);
  } finally { restore(); }
});

test('빈 검색어는 현재 질문으로 대신한다', async () => {
  const restore = silence();
  try {
    const llm = scripted([{ action: 'search', targets: ALL }]);
    const calls = [];
    await handleQuestion('  BATCH001 상태  ', [], { deps: { decide: llm.decide, search: async (t, g) => { calls.push([t, g]); return found({ knowledge: [K(1)] }); } } });
    assert.deepStrictEqual(calls, [['BATCH001 상태', ALL]]);
  } finally { restore(); }
});

test('같은 검색어·대상의 반복은 실행하지 않고 note로 남긴다 — 연속되면 강제 답변으로 간다', async () => {
  const restore = silence();
  try {
    const same = { action: 'search', text: '배치', targets: ['knowledge'] };
    const llm = scripted([same, { ...same, text: ' 배치 ' }, same, same]);
    let times = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search: async () => { times++; return found({ knowledge: [K(1)] }); } } });
    assert.equal(times, 1, '같은 검색이 다시 실행됐다');
    assert.equal(r.trace.length, 3, '실행 1건 + 반복 note 2건 뒤에 강제 답변으로 가야 한다');
    assert.match(r.trace[1].note, /이미 같은 검색어/);
    assert.equal(r.answer, '강제 답변');
    assert.ok(llm.seen.at(-1).forceAnswer, '마지막 호출이 강제 답변이어야 한다');
    assert.equal(r.search.searches, 1);
  } finally { restore(); }
});

test('같은 검색어라도 대상을 더하면 새 검색이다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: '배치', targets: ['knowledge'] },
      { action: 'search', text: '배치', targets: ['knowledge', 'query'] },
      { action: 'answer', answer: '답' },
    ]);
    const calls = [];
    const search = async (t, g) => { calls.push(g); return found({ knowledge: [K(1)], ...(g.includes('query') && { queries: [Q(7, 'q7')], routed: false }) }); };
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search } });
    assert.deepStrictEqual(calls, [['knowledge'], ['knowledge', 'query']]);
    assert.equal(r.trace.filter(h => h.note).length, 0);
    assert.deepStrictEqual(r.search.targets, { knowledge: 2, qa_method: 0, query: 1 });
  } finally { restore(); }
});

test('검색 횟수는 MAX_SEARCHES를 넘지 못한다', async () => {
  const restore = silence();
  try {
    const decisions = new Array(MAX_SEARCHES + 2).fill(0).map((_, i) => ({ action: 'search', text: `검색어${i}`, targets: ALL }));
    const llm = scripted(decisions);
    let times = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search: async (t) => { times++; return found({ knowledge: [K(times)] }); } } });
    assert.equal(times, MAX_SEARCHES);
    const notes = r.trace.filter(h => h.note);
    assert.ok(notes.length >= 1 && notes.every(n => /검색 횟수 상한/.test(n.note)), JSON.stringify(notes));
    assert.equal(r.search.searches, MAX_SEARCHES);
  } finally { restore(); }
});

test('검색이 성립하지 않은 대상은 0건이 아니라 failed로 남는다', async () => {
  // 임베딩 서버가 없으면 검색이 null이다(search.js). 그것을 0건으로 기록하면 모델은 '등록된 자료가 없다'고
  // 단정하고, chat_log는 그 질문을 '지식 보강 후보'로 잘못 집계한다.
  const restore = silence();
  try {
    const llm = scripted([{ action: 'search', text: 'x', targets: ALL }, { action: 'answer', answer: '답' }]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search: async () => found({ knowledge: null, qaMethods: [], queries: null, routed: true, queriesFailed: true }) } });
    assert.deepStrictEqual(r.trace[0], { search: 'x', targets: ALL, hits: { knowledge: null, qaMethods: 0, queries: null }, failed: ['knowledge', 'query'] });
    assert.equal(r.search.knowledge, null);
    assert.equal(r.search.qaMethods, 0, '찾았는데 없는 것은 0이다');
    assert.equal(r.search.searchFailed, true);
    assert.equal(r.search.queriesFailed, true);
    // 검색이 성립하지 않은 대상은 '찾아본' 것이 아니다 — 프롬프트가 그 섹션을 '(없음)'으로 실으면
    // 모델은 '등록된 자료가 없다'로 읽는다. 성립한 대상(qa_method)만 섹션으로 보이고, 성립하지 않은 것은
    // 이력의 '검색 불가' 줄이 말한다. tried는 '한 번은 찾아봤다'라서 '아직 안 찾아봤다' 안내를 막는다.
    assert.deepStrictEqual(llm.seen[1].searched, ['qa_method']);
    assert.equal(llm.seen[1].tried, true);
  } finally { restore(); }
});

test('처리방법이 지목한 쿼리는 query를 찾지 않았어도 목록에 실리되 query를 찾아본 것으로 세지 않는다', async () => {
  const restore = silence();
  try {
    const llm = scripted([{ action: 'search', text: 'x', targets: ['qa_method'] }, { action: 'answer', answer: '답' }]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search: async () => found({ qaMethods: [{ seq: 1, title: 'm', method: 'q1 실행' }], queries: [Q(1, 'q1')], routed: null }) } });
    assert.deepStrictEqual(llm.seen[1].queries.map(q => q.query_name), ['q1']);
    assert.deepStrictEqual(llm.seen[1].searched, ['qa_method']);
    assert.equal(r.trace[0].hits.queries, 1);
    assert.deepStrictEqual(r.search.targets, { knowledge: 0, qa_method: 1, query: 0 });
    assert.equal(r.search.queries, null);
  } finally { restore(); }
});

test('검색 뒤 쿼리 실행 — 진행 이벤트가 순서대로 나가고, 듣는 쪽이 던져도 루프는 계속된다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'BATCH001', targets: ['query'] },
      { action: 'run_query', query_name: 'batch_job_status', params: { a: 'BATCH001' } },
      { action: 'answer', answer: '답' },
    ]);
    const events = [];
    let thrown = 0;
    const onEvent = e => { events.push(e); if (thrown++ === 0) throw new Error('listener boom'); };
    const run = async (row, params) => ({ rows: [{ STATUS: 'OK' }], totalRows: 1, capped: false, targetDb: 'D' });
    const r = await handleQuestion('BATCH001 상태', [], {
      onEvent,
      deps: { decide: llm.decide, run, search: async () => found({ queries: [Q(1, 'batch_job_status')], routed: false }) },
    });
    assert.equal(r.answer, '답');
    assert.deepStrictEqual(events.map(e => e.type), ['search', 'search_done', 'run_query', 'run_query_done']);
    assert.deepStrictEqual(events[0], { type: 'search', text: 'BATCH001', targets: ['query'] });
    assert.deepStrictEqual(events[1].hits, { knowledge: null, qaMethods: null, queries: 1 });
    assert.deepStrictEqual(events[2], { type: 'run_query', id: 1, query_name: 'batch_job_status', params: { a: 'BATCH001' }, targetDb: 'D' });
    assert.deepStrictEqual(events[3], { type: 'run_query_done', id: 1, query_name: 'batch_job_status', targetDb: 'D', rowCount: 1 });
    assert.equal(r.trace.length, 2);
    assert.equal(r.timing.oracle.length, 1);
    // 모델이 지목한 쿼리는 다음 스텝에 자세히 보인다
    assert.equal(llm.seen[2].queries[0].detail, true);
  } finally { restore(); }
});

test('조회 실패 이벤트는 우리가 만든 문구만 원문으로 내보낸다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', targets: ['query'] },
      { action: 'run_query', query_name: 'q1', params: {} },
      { action: 'run_query', query_name: 'q1', params: { a: 2 } },
      { action: 'answer', answer: '답' },
    ]);
    const events = [];
    let n = 0;
    const run = async () => { throw n++ === 0 ? Object.assign(new Error('ORA-00942 at HOST/SCHEMA'), {}) : Object.assign(new Error('우리 문구'), { safe: true }); };
    await handleQuestion('q', [], { onEvent: e => events.push(e), deps: { decide: llm.decide, run, search: async () => found({ queries: [Q(1, 'q1')], routed: false }) } });
    const dones = events.filter(e => e.type === 'run_query_done');
    assert.equal(dones[0].error, '조회 중 오류가 발생했습니다.');
    assert.equal(dones[1].error, '우리 문구');
  } finally { restore(); }
});

test('쿼리 실행 결정은 MAX_STEPS를 넘지 못하고, 검색은 그 수에 들어가지 않는다', async () => {
  const restore = silence();
  try {
    const decisions = [{ action: 'search', targets: ['query'] }];
    for (let i = 0; i < MAX_STEPS + 2; i++) decisions.push({ action: 'run_query', query_name: 'q1', params: { a: i } });
    const llm = scripted(decisions);
    let runs = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, run: async () => { runs++; return { rows: [], totalRows: 0, capped: false, targetDb: 'D' }; }, search: async () => found({ queries: [Q(1, 'q1')], routed: false }) } });
    assert.equal(runs, MAX_STEPS, '검색이 쿼리 스텝을 잡아먹거나, 쿼리 스텝이 상한을 넘었다');
    assert.equal(r.answer, '강제 답변');
    assert.equal(r.trace.length, MAX_STEPS + 1);
  } finally { restore(); }
});

test('새 자료가 없는 검색이 연속되면 강제 답변으로 간다 — 한 번은 검색어를 고칠 기회를 준다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'a', targets: ALL }, { action: 'search', text: 'b', targets: ALL }, { action: 'search', text: 'c', targets: ALL },
    ]);
    let times = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search: async () => { times++; return found({ knowledge: [], qaMethods: [] }); } } });
    assert.equal(times, 2, '0건 검색은 두 번째까지만 — 그 뒤는 강제 답변');
    assert.equal(r.answer, '강제 답변');
  } finally { restore(); }
});

test('searchKey는 검색어의 대소문자·공백과 대상 순서를 흡수한다', () => {
  assert.equal(searchKey(' Batch ', ['query', 'knowledge']), searchKey('batch', ['knowledge', 'query']));
  assert.notEqual(searchKey('batch', ['knowledge']), searchKey('batch', ['knowledge', 'query']));
  assert.notEqual(searchKey('batch', ['knowledge']), searchKey('배치', ['knowledge']));
});

// 이번 검색이 찾은 것은 새것이든 이미 있던 것이든 앞으로 온다 — 예산이 꼬리부터 버리므로, 있던 항목을 제자리에
// 두면 이번 검색의 1위가 지난 검색의 꼬리에 남아 잘린다. 돌려주는 값은 새로 넣었거나 달라진 수다(순서만 바뀐 것은 아니다).
test('mergeFront는 이번 검색이 찾은 것을 관련도 순으로 앞에 두고, 새로 넣었거나 달라진 수를 돌려준다', () => {
  const list = [K(1), K(2)];
  assert.equal(mergeFront(list, [K(2), K(3), K(3), K(4)]), 2);
  assert.deepStrictEqual(list.map(k => k.seq), [2, 3, 4, 1], '다시 찾은 항목도 이번 검색의 순서로 앞에 와야 한다');
  assert.equal(mergeFront(list, [K(1)]), 0, '순서만 바뀐 것은 진도가 아니다');
  assert.deepStrictEqual(list.map(k => k.seq), [1, 2, 3, 4]);
});

// 본문 청구(expand)가 항목을 맨 앞으로 옮기는 것은 '예산이 뒤에서부터 버리므로 그 자리라야 살아남는다'가
// 이유다(context.md 2-3). 뒤이은 검색이 그 앞에 후보를 쌓으면 그 이유가 통째로 무너진다 — 펼친 본문
// (MAX_DOC_LEN)이 섹션 몫 밖으로 밀려나는데, 펼친 항목에는 번호가 붙지 않으므로 모델은 사라진
// 것을 볼 수도 다시 청구할 수도 없고 MAX_EXPANDS만 하나 잃는다. 오류가 한 줄도 남지 않는 종류라 여기서 잰다.
test('mergeFront는 펼친 항목을 넘어서지 않는다 — 검색은 펼침 구간 뒤에 끼운다', () => {
  const list = [{ ...K(5), expanded: true }, K(1), K(2)];
  assert.equal(mergeFront(list, [K(7), K(8)]), 2);
  assert.deepStrictEqual(list.map(k => k.seq), [5, 7, 8, 1, 2]);

  // 펼침이 여럿이어도(applyExpand가 unshift만 하므로 목록의 접두사를 이룬다) 그 구간 전체를 건너뛴다.
  const two = [{ ...K(6), expanded: true }, { ...K(5), expanded: true }, K(1)];
  mergeFront(two, [K(9)]);
  assert.deepStrictEqual(two.map(k => k.seq), [6, 5, 9, 1]);

  // 전부 펼친 목록이면 뒤에 붙인다 (findIndex가 -1을 주는 경계).
  const all = [{ ...K(6), expanded: true }, { ...K(5), expanded: true }];
  mergeFront(all, [K(9)]);
  assert.deepStrictEqual(all.map(k => k.seq), [6, 5, 9]);
});

// 청크 항목의 seq는 '가장 가까운 청크'의 seq다(chunk.js buildItems). 두 번째 검색에서 같은 문서의
// 다른 청크가 대표가 되면 seq가 달라지므로, seq로만 거르면 같은 문서가 두 항목으로 들어와 지식 몫을
// 두 번 먹는다 — 모델은 같은 글을 두 번 읽고, 그 중복은 어디에도 기록되지 않는다.
test('mergeFront는 청크 항목을 문서 단위로 거른다 — 대표 청크가 바뀌어도', () => {
  const item = (seq, doc) => ({ seq, doc_seq: doc, title: `문서${doc}`, content: '본문' });
  const list = [item(101, 1)];
  // 같은 문서(1)의 다른 대표(105) + 새 문서(2) — 문서 1은 항목이 하나여야 하고, 이번 검색 순서대로 앞에 온다
  assert.equal(mergeFront(list, [item(105, 1), item(201, 2)]), 1);
  assert.deepStrictEqual(list.map(o => o.doc_seq), [1, 2]);
  assert.deepStrictEqual(list.map(o => o.seq), [101, 201], '먼저 온 항목의 seq가 요청 내내 고정이어야 한다');
});

// 항목의 정체는 문서고 구간은 최신 검색을 따른다. 먼저 온 구간을 무조건 지키면 뒤 검색이 같은 문서의 다른 절을
// 찾아도 그 절이 통째로 버려지고, 모델은 그것이 존재한다는 사실조차 볼 수 없다 — 오류 없는 오답의 전형이다.
const CHUNK_ITEM = (seq, doc, from, to, content, over = {}) =>
  ({ seq, doc_seq: doc, chunk_of: 22, rep: from, from, to, range: ` (${from === to ? from : `${from}~${to}`}/22)`, title: `문서${doc}`, content, full: false, ...over });

test('mergeFront는 같은 문서의 다른 구간이 뒤 검색에 걸리면 seq를 지키고 구간을 바꾼다', () => {
  const list = [CHUNK_ITEM(101, 1, 3, 3, 'A절')];
  assert.equal(mergeFront(list, [CHUNK_ITEM(115, 1, 15, 17, 'B절')]), 1, '구간이 달라졌으면 진도다');
  assert.equal(list.length, 1, '같은 문서가 두 항목으로 들어오면 안 된다');
  assert.equal(list[0].seq, 101, '모델이 지목하는 번호는 요청 내내 고정이다');
  assert.equal(list[0].content, 'B절');
  assert.equal(list[0].range, ' (15~17/22)');
  // 이번 구간이 이미 실린 구간 안에 들면 넓은 쪽을 둔다 — 좁혀서는 안 된다.
  assert.equal(mergeFront(list, [CHUNK_ITEM(116, 1, 16, 16, 'B절의 한 조각')]), 0);
  assert.equal(list[0].content, 'B절');
});

test('mergeFront는 펼친 항목의 구간과 자리를 지킨다 — 청구한 구간이 검색으로 바뀌면 안 된다', () => {
  const pinned = CHUNK_ITEM(101, 1, 3, 7, '청구해 넓힌 절', { expanded: true });
  const list = [pinned, K(9)];
  assert.equal(mergeFront(list, [CHUNK_ITEM(115, 1, 15, 17, 'B절'), K(8)]), 1);
  assert.deepStrictEqual(list.map(o => o.seq), [101, 8, 9]);
  assert.equal(pinned.content, '청구해 넓힌 절');
  assert.equal(pinned.range, ' (3~7/22)');
});

test('mergeFront는 버린 청크 항목에 겹치지 않는 구간이 걸리면 되살리고, 겹치면 버린 채로 둔다', () => {
  const dropped = CHUNK_ITEM(101, 1, 3, 5, 'A절', { dropped: true });
  const list = [K(9), dropped];
  assert.equal(mergeFront(list, [CHUNK_ITEM(104, 1, 4, 6, 'A절 근처')]), 0, '겹치는 구간은 같은 내용이다 — 버린 것이 되살아나면 안 된다');
  assert.equal(dropped.dropped, true);
  assert.equal(dropped.content, 'A절');
  assert.deepStrictEqual(list.map(o => o.seq), [9, 101], '버린 채로 둔 항목은 자리도 그대로다');
  assert.equal(mergeFront(list, [CHUNK_ITEM(115, 1, 15, 17, 'B절')]), 1, '다른 절은 모델이 버린 것이 아니다');
  assert.equal(dropped.dropped, false);
  assert.equal(dropped.content, 'B절');
  assert.equal(dropped.seq, 101);
  assert.deepStrictEqual(list.map(o => o.seq), [101, 9], '되살아난 항목은 이번 검색의 결과로 앞에 온다');
  // 펼쳤다가 버린 항목도 같다 — 새 구간은 핀이 아니다.
  const pinnedDropped = CHUNK_ITEM(201, 2, 3, 7, 'X', { expanded: true, dropped: true });
  const two = [pinnedDropped, K(9)];
  assert.equal(mergeFront(two, [CHUNK_ITEM(215, 2, 15, 17, 'Y')]), 1);
  assert.equal(pinnedDropped.expanded, false);
  assert.deepStrictEqual(two.map(o => o.seq), [201, 9]);
  // 청크가 아닌 항목(처리방법)은 같은 내용뿐이라 되살아날 길이 없다.
  const m = { ...K(5), dropped: true };
  const three = [m];
  assert.equal(mergeFront(three, [K(5)]), 0);
  assert.equal(m.dropped, true);
});

test('mergeFront의 문서 단위 판정은 청크가 아닌 항목을 건드리지 않는다', () => {
  const list = [K(1)];
  assert.equal(mergeFront(list, [K(1), K(2)]), 1);
  assert.deepStrictEqual(list.map(k => k.seq), [1, 2]);
});

// ===== 일괄 조회 (run_queries) =====

test('일괄 조회는 병렬로 돌고 이력은 배치 순서를 지킨다 — 끝나는 순서와 무관하게', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', targets: ['query'] },
      { action: 'run_queries', queries: [{ query_name: 'q1', params: { a: 1 } }, { query_name: 'q2', params: { a: 2 } }, { query_name: 'q1', params: { a: 3 } }] },
      { action: 'answer', answer: '답' },
    ]);
    let active = 0, peak = 0;
    const run = async (row, params) => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, params.a === 1 ? 60 : 10));   // 첫 항목이 가장 늦게 끝난다
      active--;
      return { rows: [{ V: params.a }], totalRows: 1, capped: false, targetDb: 'D' };
    };
    const events = [];
    const r = await handleQuestion('q', [], { onEvent: e => events.push(e), deps: { decide: llm.decide, run, search: async () => found({ queries: [Q(1, 'q1'), Q(2, 'q2')], routed: false }) } });
    assert.equal(peak, 3, '병렬로 돌지 않았다');
    assert.deepStrictEqual(r.trace.slice(1).map(h => [h.query_name, h.params.a, h.rows[0].V]), [['q1', 1, 1], ['q2', 2, 2], ['q1', 3, 3]]);
    assert.equal(events.filter(e => e.type === 'run_query_done').length, 3);
    // 조회 시간은 배치의 실제 경과로 한 번만 잰다 — 항목마다 재면 병렬로 겹친 시간이 그 수만큼 더해져
    // 계측이 조회 몫을 부풀린다(4건이 2초에 끝나도 8초로 남는다). README가 그 숫자로 조정을 판단한다.
    assert.equal(r.timing.oracle.length, 1, '배치 하나가 항목 수만큼 기록됐다');
    assert.ok(r.timing.oracle[0] < 200, `겹친 시간이 더해졌다: ${r.timing.oracle[0]}ms (가장 느린 항목은 60ms)`);
    // 시작·끝 이벤트는 짝 번호로 이어진다 — 이름·대상 DB로는 짝을 지을 수 없다(같은 쿼리를 다른 값으로 부르는
    // 배치가 정당하고, 대상 DB의 철자도 시작(모델)과 끝(등록)이 다를 수 있다).
    const starts = events.filter(e => e.type === 'run_query');
    const dones = events.filter(e => e.type === 'run_query_done');
    assert.deepStrictEqual(starts.map(e => e.id), [1, 2, 3]);
    assert.deepStrictEqual([...dones.map(e => e.id)].sort(), [1, 2, 3]);
    assert.equal(llm.seen.length, 3, 'LLM 왕복은 검색·일괄 조회·답변 셋뿐이어야 한다');
    // 차트·표 참조가 보는 스텝 번호는 배치 순서다 (2번 = q1 a:1)
    assert.equal(r.fullRows.get(r.trace[1])[0].V, 1);
  } finally { restore(); }
});

test('일괄 조회도 MAX_STEPS 안이다 — 넘치는 항목은 잘리고 강제 답변으로 간다', async () => {
  const restore = silence();
  try {
    const many = Array.from({ length: MAX_STEPS + 3 }, (_, i) => ({ query_name: 'q1', params: { a: i } }));
    const llm = scripted([{ action: 'search', targets: ['query'] }, { action: 'run_queries', queries: many }, { action: 'run_query', query_name: 'q1', params: { a: 99 } }]);
    let runs = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, run: async () => { runs++; return { rows: [], totalRows: 0, capped: false, targetDb: 'D' }; }, search: async () => found({ queries: [Q(1, 'q1')], routed: false }) } });
    assert.equal(runs, MAX_STEPS);
    assert.equal(r.answer, '강제 답변');
    // 상한에 걸려 실행하지 못한 항목은 조용히 사라지지 않는다 — 모델은 자기가 몇을 요청했는지 안다
    const dropped = r.trace.filter(h => /조회 스텝 상한/.test(h.note ?? ''));
    assert.equal(dropped.length, 1, JSON.stringify(r.trace.map(h => h.note ?? h.query_name)));
    assert.equal(r.trace.length, MAX_STEPS + 2, '검색 1 + 실행 MAX_STEPS + 안내 1');
    // 안내는 실행 줄 '뒤'에 온다 — 앞에 오면 아직 나오지도 않은 결과를 두고 '실행하지 않았다'가 먼저 읽히고,
    // 그 줄이 낮은 번호를 차지해 모델이 답변에서 가리키는 번호도 함께 밀린다.
    assert.equal(r.trace.at(-1).note, dropped[0].note, `안내가 실행 줄보다 먼저 기록됐다: ${JSON.stringify(r.trace.map(h => h.note ? 'note' : h.query_name))}`);
  } finally { restore(); }
});

test('배치 안의 중복·미등록·가드 항목은 실행하지 않고 각자 기록되며, 하나라도 성공하면 진도다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', targets: ['query'] },
      { action: 'run_query', query_name: 'q1', params: { a: 1 } },
      { action: 'run_queries', queries: [
        { query_name: 'q1', params: { a: 1 } },      // 이력에 이미 있다 → 루프 가드
        { query_name: 'q2', params: { a: 2 } },
        { query_name: 'q2', params: { a: 2 } },      // 같은 배치 안 중복
        { query_name: 'nope', params: {} },          // 미등록 (목록에 없고 캐시도 없다 — DB를 부르지 않게 resolveCache를 채운다)
      ] },
      { action: 'answer', answer: '답' },
    ]);
    const run = async (row, params) => ({ rows: [{ V: params.a }], totalRows: 1, capped: false, targetDb: 'D' });
    // 미등록 이름은 DB 재조회를 타므로 여기서는 이름을 목록에 넣되 등록 행이 아닌 것으로 만들 수 없다 —
    // 대신 run 스텁이 미등록을 흉내 낼 수 없으니, 목록에 'nope'를 넣지 않고 resolveQuery가 DB로 가기 전에
    // 캐시를 채울 수 없다. 그래서 이 항목은 배치에서 빼고 셋만 본다.
    llm.seen.length = 0;
    const decisions = llm;
    const r = await handleQuestion('q', [], { deps: { decide: async ctx => {
      const d = await decisions.decide(ctx);
      if (d?.action === 'run_queries') d.queries = d.queries.filter(q => q.query_name !== 'nope');
      return d;
    }, run, search: async () => found({ queries: [Q(1, 'q1'), Q(2, 'q2')], routed: false }) } });
    const batch = r.trace.slice(2);
    assert.equal(batch.length, 3);
    assert.match(batch[0].note, /이미 같은 파라미터/);
    assert.equal(batch[1].rows[0].V, 2);
    assert.match(batch[2].note, /같은 배치 안/);
    assert.equal(r.answer, '답');
  } finally { restore(); }
});

test('전부 헛돈 배치는 연속 가드로 세고, 강제 답변으로 간다', async () => {
  const restore = silence();
  try {
    const dup = { query_name: 'q1', params: { a: 1 } };
    const llm = scripted([
      { action: 'search', targets: ['query'] },
      { action: 'run_query', ...dup },
      { action: 'run_queries', queries: [dup, dup] },   // 둘 다 가드 → 헛돈 배치 1
      { action: 'run_queries', queries: [dup] },        // 헛돈 배치 2 → 강제 답변
      { action: 'answer', answer: '여기 오면 안 된다' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, run: async () => ({ rows: [{ V: 1 }], totalRows: 1, capped: false, targetDb: 'D' }), search: async () => found({ queries: [Q(1, 'q1')], routed: false }) } });
    assert.equal(r.answer, '강제 답변');
  } finally { restore(); }
});

test('답변의 table 참조는 그 스텝의 전체 행으로 채워진다', async () => {
  const restore = silence();
  try {
    const rowsAll = Array.from({ length: 25 }, (_, i) => ({ ID: i, NAME: `n${i}` }));
    const llm = scripted([
      { action: 'search', targets: ['query'] },
      { action: 'run_query', query_name: 'q1', params: {} },
      { action: 'answer', answer: '결과:\n\n```table\nstep: 2\ncols: NAME\nlimit: 2\n```\n\n끝' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, run: async () => ({ rows: rowsAll, totalRows: 25, capped: false, targetDb: 'D' }), search: async () => found({ queries: [Q(1, 'q1')], routed: false }) } });
    assert.equal(r.answer, '결과:\n\n| NAME |\n| --- |\n| n0 |\n| n1 |\n_(25행 중 처음 2행만 실었습니다 — 전부는 아래 ⚡ 패널에 있습니다)_\n\n끝');
  } finally { restore(); }
});

test('이력은 MAX_HISTORY_ROWS 줄을 넘지 않는다 — 검색·일괄 조회·가드 안내가 뒤섞여도', async () => {
  // 일괄 조회 전에는 루프 반복 수가 곧 줄 수여서 이 상한이 저절로 지켜졌다. 결정 하나가 조회 여럿을 만들게
  // 되면서 줄이 반복 수보다 많아질 수 있는데, 그러면 프롬프트의 이력 몫이 보장하는 '전부 실린다'가 깨져
  // 가장 오래된 조회 결과가 조용히 빠진다 (test/prompt.test.js가 그 몫을 따로 지킨다).
  const restore = silence();
  try {
    const decisions = [];
    for (let i = 0; i < MAX_SEARCHES; i++) {
      decisions.push({ action: 'search', text: `검색${i}`, targets: ALL });
      decisions.push({ action: 'search', text: `검색${i}`, targets: ALL });   // 같은 검색 → 안내 줄
    }
    for (let i = 0; i < 4; i++) {
      decisions.push({ action: 'run_queries', queries: Array.from({ length: 4 }, (_, j) => ({ query_name: 'q1', params: { a: i * 4 + j } })) });
    }
    const llm = scripted(decisions);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: {
      decide: llm.decide,
      run: async () => ({ rows: [{ V: n++ }], totalRows: 1, capped: false, targetDb: 'D' }),
      search: async () => found({ knowledge: [K(++n)], qaMethods: [], queries: [Q(1, 'q1')], routed: false }),
    } });
    assert.ok(r.trace.length <= MAX_HISTORY_ROWS, `이력이 ${r.trace.length}줄 — 상한 ${MAX_HISTORY_ROWS}을 넘었다`);
    // 상한에 실제로 닿아야 이 검사가 무언가를 재는 것이다 (닿지 않으면 다른 상한이 먼저 걸린 것이다)
    assert.equal(r.trace.length, MAX_HISTORY_ROWS, `상한에 닿지 않아 아무것도 재지 못했다: ${r.trace.length}줄`);
    // 조회 줄은 조회 수 상한 안이다
    assert.ok(r.trace.filter(h => h.rows).length <= MAX_STEPS);
  } finally { restore(); }
});

test('검색이 던져도 이미 조회해둔 결과를 버리지 않는다 — 그 검색만 검색 불가로 남는다', async () => {
  // 결정·조회는 각자 예외를 삼킨다(함께 버려지는 것이 이미 조회해둔 결과이기 때문이다). 검색을 루프
  // 안으로 들여오면서 그 await만 밖에 있었다 — 두 번째 검색이 던지면 첫 조회 결과까지 통째로 잃고 500이 된다.
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'a', targets: ['query'] },
      { action: 'run_query', query_name: 'q1', params: { a: 1 } },
      { action: 'search', text: 'b', targets: ['knowledge', 'qa_method'] },
      { action: 'answer', answer: '답' },
    ]);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: {
      decide: llm.decide,
      run: async () => ({ rows: [{ V: 1 }], totalRows: 1, capped: false, targetDb: 'D' }),
      search: async () => { if (n++ === 0) return found({ queries: [Q(1, 'q1')], routed: false }); throw new Error('임베딩 폭발'); },
    } });
    assert.equal(r.answer, '답');
    assert.equal(r.trace.filter(h => h.rows).length, 1, '조회 결과가 사라졌다');
    const 던진검색 = r.trace.at(-1);
    assert.deepStrictEqual(던진검색.failed, ['knowledge', 'qa_method'], '요청한 대상이 검색 불가로 남아야 한다');
    assert.equal(r.search.searchFailed, true);
  } finally { restore(); }
});

test('라우팅 판정은 성립한 쿼리 검색의 것만 남는다 — 뒤이은 실패가 지우지 않는다', async () => {
  // 마지막 값으로 덮으면, 앞선 검색이 목록을 채워 놓고도 뒤 검색이 관리 DB 실패로 null을 주는 순간
  // chat_log에 '한 번도 못 찾았거나 매번 실패했다'로 남아(README 분석 SQL) 정반대로 읽힌다.
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'a', targets: ['query'] },
      { action: 'search', text: 'b', targets: ['query'] },
      { action: 'answer', answer: '답' },
    ]);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, search: async () => (n++ === 0
      ? found({ queries: [Q(1, 'q1'), Q(2, 'q2')], routed: true })
      : found({ queries: null, routed: null, queriesFailed: true })) } });
    assert.equal(r.search.queries, 2, '앞선 검색의 라우팅 판정이 지워졌다');
    assert.equal(r.search.queriesFailed, true, '실패한 사실은 그대로 남아야 한다');
  } finally { restore(); }
});

test('실행할 것이 하나도 없는 배치는 조회 시간에 기록되지 않는다', async () => {
  // 0ms짜리 항목이 조회 횟수를 부풀린다 — README가 그 숫자로 검색 폭을 조정하라고 가리킨다.
  const restore = silence();
  try {
    const dup = { query_name: 'q1', params: { a: 1 } };
    const llm = scripted([
      { action: 'search', targets: ['query'] },
      { action: 'run_query', ...dup },
      { action: 'run_queries', queries: [dup, dup] },   // 둘 다 가드 — 실행되는 것이 없다
      { action: 'answer', answer: '답' },
    ]);
    let runs = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      run: async () => { runs++; return { rows: [{ V: 1 }], totalRows: 1, capped: false, targetDb: 'D' }; },
      search: async () => found({ queries: [Q(1, 'q1')], routed: false }) } });
    assert.equal(runs, 1);
    assert.equal(r.timing.oracle.length, 1, `실행 없는 배치가 계측에 들어갔다: ${JSON.stringify(r.timing.oracle)}`);
  } finally { restore(); }
});

// ===== 본문 청구(expand)와 버리기(drop) =====
// 둘 다 조용히 깨진다. 펼친 항목이 목록 뒤에 남으면 예산에 밀려 정작 그 본문이 잘리고, 버린 항목이
// 목록에서 빠지면 다음 검색이 같은 것을 다시 실어 온다 — 어느 쪽도 오류를 남기지 않는다.
const LONG = (seq, title) => ({ seq, title, content: `${title} 본문 `.repeat(400) });

test('본문 청구는 표시를 세우고 그 항목을 목록 맨 앞으로 옮긴다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['knowledge'] },
      { action: 'expand', ids: ['k2'] },
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ knowledge: [LONG(1, '첫째'), LONG(2, '둘째'), LONG(3, '셋째')] }) } });
    const seen = llm.seen.at(-1).knowledge;
    assert.deepStrictEqual(seen.map(k => k.seq), [2, 1, 3], '펼친 항목이 앞으로 오지 않았다 — 예산에 밀려 잘린다');
    assert.equal(seen[0].expanded, true);
    assert.ok(!seen[1].expanded && !seen[2].expanded);
    assert.equal(r.search.expanded, 1);
    assert.equal(r.trace.filter(h => h.expand !== undefined).length, 0, '성공한 청구는 이력에 남지 않는다');
  } finally { restore(); }
});

test('버린 항목은 프롬프트에서 빠지고 재검색으로 되살아나지 않는다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'a', targets: ['knowledge'] },
      { action: 'search', text: 'b', targets: ['knowledge'], drop: ['k1'] },
      { action: 'answer', answer: '답' },
    ]);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      // 두 번째 검색이 버린 항목을 다시 찾아온다 — 되살아나면 안 된다
      search: async () => found({ knowledge: n++ === 0 ? [K(1), K(2)] : [K(1), K(3)] }) } });
    const last = llm.seen.at(-1).knowledge;
    assert.deepStrictEqual(last.filter(k => !k.dropped).map(k => k.seq), [3, 2]);
    assert.equal(last.find(k => k.seq === 1).dropped, true, '버린 항목이 목록에서 사라지면 재검색으로 되살아난다');
    assert.equal(r.search.dropped, 1);
  } finally { restore(); }
});

test('버리기는 검색보다 먼저 적용된다 — 방금 버린 것이 그 검색으로 되살아나지 않게', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'a', targets: ['knowledge'] },
      { action: 'search', text: 'b', targets: ['knowledge'], drop: ['k1'] },
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ knowledge: [K(1)] }) } });   // 두 검색이 같은 항목만 돌려준다
    assert.equal(llm.seen.at(-1).knowledge.find(k => k.seq === 1).dropped, true);
    assert.equal(r.search.dropped, 1);
  } finally { restore(); }
});

test('펼칠 것이 없는 청구는 안내를 남기고 헛돈 스텝으로 센다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['knowledge'] },
      { action: 'expand', ids: ['k99'] },   // 목록에 없다
      { action: 'expand', ids: ['k99'] },   // 두 번째 — 강제 답변으로 간다
      { action: 'answer', answer: '여기 오면 안 된다' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ knowledge: [LONG(1, 'K')] }) } });
    assert.equal(r.answer, '강제 답변');
    const notes = r.trace.filter(h => h.expand !== undefined);
    assert.equal(notes.length, 2);
    assert.match(notes[0].note, /번호가 붙은 항목만/);
  } finally { restore(); }
});

test('청구 상한을 넘으면 더 펼치지 않고 그 사실을 알린다', async () => {
  const restore = silence();
  try {
    const ids = Array.from({ length: MAX_EXPANDS + 1 }, (_, i) => `k${i + 1}`);
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['knowledge'] },
      { action: 'expand', ids },              // 상한까지만 펼쳐진다
      { action: 'expand', ids: ['k9'] },      // 상한에 닿았다
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ knowledge: ids.concat('k9').map((_, i) => LONG(i + 1, `K${i + 1}`)) }) } });
    assert.equal(r.search.expanded, MAX_EXPANDS);
    assert.match(r.trace.find(h => h.expand !== undefined).note, /상한/);
  } finally { restore(); }
});

test('버리기만 한 청구도 진도로 본다 — 자료가 달라졌다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['knowledge'] },
      { action: 'expand', ids: ['k99'], drop: ['k1'] },   // 펼치지는 못했지만 버렸다
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ knowledge: [K(1), K(2)] }) } });
    assert.equal(r.answer, '답');
    assert.equal(r.search.dropped, 1);
    assert.equal(r.trace.filter(h => h.expand !== undefined).length, 0, '진도가 났으면 안내를 남기지 않는다');
  } finally { restore(); }
});

test('이력 줄 수 상한은 본문 청구가 섞여도 지켜진다', async () => {
  const restore = silence();
  try {
    const decisions = [];
    for (let i = 0; i < MAX_SEARCHES; i++) {
      decisions.push({ action: 'search', text: `검색${i}`, targets: ALL });
      decisions.push({ action: 'expand', ids: ['k99'] });          // 매번 헛돌아 안내를 남긴다
      decisions.push({ action: 'search', text: `검색${i}`, targets: ALL });   // 같은 검색 — 안내
    }
    for (let i = 0; i < 3; i++) decisions.push({ action: 'run_queries', queries: [
      { query_name: 'q1', params: { a: i * 2 } }, { query_name: 'q1', params: { a: i * 2 + 1 } }] });
    const llm = scripted(decisions);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      run: async () => ({ rows: [{ V: n++ }], totalRows: 1, capped: false, targetDb: 'D' }),
      search: async () => found({ knowledge: [K(++n)], qaMethods: [], queries: [Q(1, 'q1')], routed: false }) } });
    assert.ok(r.trace.length <= MAX_HISTORY_ROWS, `이력이 ${r.trace.length}줄 — 상한 ${MAX_HISTORY_ROWS}을 넘었다`);
  } finally { restore(); }
});

// ===== 청크 항목의 본문 청구 =====
// growItem은 관리 DB에서 청크를 읽는다 — deps.loadChunks가 그 자리다. 이 판정은 양쪽으로 조용히 깨진다:
// 늘지 않을 항목에 번호가 남으면 모델이 그 번호로 청구하느라 스텝을 버리고(두 번이면 강제 답변), 늘 수 있는
// 항목에서 번호를 떼면 긴 문서의 뒷부분이 영영 실리지 않는다. 어느 쪽도 오류를 남기지 않는다.
const CH = (doc, no, len = 900, of = 22) =>
  ({ seq: doc * 1000 + no, doc_seq: doc, chunk_no: no, chunk_of: of, title: `문서${doc}`, content: '가'.repeat(len) });
const loaderOf = rows => async ranges =>
  rows.filter(r => ranges.some(g => g.doc_seq === r.doc_seq && r.chunk_no >= g.from && r.chunk_no <= g.to));
const firstItemLine = ctx => buildPrompt(ctx).split('\n').find(l => l.startsWith('- '));

test('청구로 넓힌 항목이 더 넓힐 수 없게 되면 번호가 사라진다 — 헛도는 청구를 막는다', async () => {
  const restore = silence();
  try {
    const rows = Array.from({ length: 22 }, (_, i) => CH(1, i + 1));
    // 검색이 돌려준 항목: 5번 적중, 이웃(4·6)을 함께 읽어 왔고 둘 다 들어간다 — 번호가 붙는다.
    const [item] = buildItems(planRanges([{ doc_seq: 1, chunk_no: 5, _dist: 0.3, chunk_of: 22 }]),
      rows.filter(r => r.chunk_no >= 4 && r.chunk_no <= 6));
    assert.ok(canGrow(item), '이 시나리오는 검색 시점에 번호가 붙어야 뜻이 있다');
    const before = item.content.length;   // 항목은 제자리에서 넓혀진다 — 비교 기준을 미리 적어 둔다
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['knowledge'] },
      { action: 'expand', ids: [`k${item.seq}`] },
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, loadChunks: loaderOf(rows),
      search: async () => found({ knowledge: [item] }) } });
    assert.equal(r.answer, '답');
    assert.equal(r.search.expanded, 1);
    const grown = llm.seen.at(-1).knowledge[0];
    assert.ok(grown.content.length > before, '청구가 범위를 넓히지 못했다');
    assert.ok(grown.content.length < MAX_DOC_LEN && grown.to < 22, '이 시나리오는 상한에 닿지 않고 범위 밖 청크가 남아야 뜻이 있다');
    assert.equal(grown.full, true, '다음 조각이 상한에 안 들어가면 더 받을 것이 없다');
    assert.match(firstItemLine(llm.seen.at(-1)), /^- \[문서1 /, '한 글자도 늘지 않을 항목에 번호가 남았다');
  } finally { restore(); }
});

test('검색 시점에 이웃을 못 읽은 항목이 청구로도 늘지 않으면 그 사실을 알리고 번호를 뗀다', async () => {
  const restore = silence();
  try {
    const rows = Array.from({ length: 8 }, (_, i) => CH(1, i + 1, 1000, 8));
    // 계획된 범위(1~4)만 읽힌 항목 — 이웃 5번을 모르니 번호가 붙는다. 청구해 읽어 보면 5번(1,000자)은 안 들어간다.
    const [item] = buildItems([{ doc_seq: 1, rep: 2, from: 1, to: 4, chunk_of: 8, dist: 0.3 }], rows.slice(0, 4));
    assert.ok(canGrow(item) && !item.full, '이 시나리오는 검색 시점에 번호가 붙어야 뜻이 있다');
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['knowledge'] },
      { action: 'expand', ids: [`k${item.seq}`] },
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide, loadChunks: loaderOf(rows),
      search: async () => found({ knowledge: [item] }) } });
    assert.equal(r.answer, '답');
    assert.equal(r.search.expanded, undefined, '늘지 않은 청구는 펼침으로 세지 않는다');
    const note = r.trace.find(h => h.expand !== undefined)?.note;
    assert.match(note ?? '', /더 넓힐 수 없다/, '번호가 붙은 항목을 청구했는데 "번호가 붙은 항목만"이라고 답하면 모순이다');
    const seen = llm.seen.at(-1).knowledge[0];
    assert.equal(seen.full, true);
    assert.match(firstItemLine(llm.seen.at(-1)), /^- \[문서1 /, '다음 프롬프트에서 번호가 사라져야 같은 청구를 반복하지 않는다');
  } finally { restore(); }
});

// 프롬프트는 '아직 안 찾음'·'찾았는데 없음'·'못 찾아봤음'을 가른다(llm-openai.js section 주석). 경로A만 돈 검색이
// '쿼리 0건'을 적으면 찾아보지 않은 대상이 '찾았는데 없다'로 보여, 모델은 query 검색을 이미 한 것으로 읽고 건너뛴다.
test('경로A만 돈 검색은 지목된 쿼리가 없으면 쿼리 적중 수를 적지 않는다', async () => {
  const restore = silence();
  try {
    const llm = scripted([{ action: 'search', text: 'x', targets: ['qa_method'] }, { action: 'answer', answer: '답' }]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ qaMethods: [{ seq: 1, title: 'm', method: '쿼리 없음' }], queries: [], routed: null }) } });
    assert.equal(r.trace[0].hits.queries, null, 'query를 찾지 않았고 지목된 쿼리도 없으면 null이어야 한다');
    const line = buildPrompt(llm.seen[1]).split('\n').find(l => /^1\. 검색/.test(l));
    assert.ok(!line.includes('쿼리'), `찾아보지 않은 대상이 이력 줄에 실렸다: ${line}`);
    assert.deepStrictEqual(llm.seen[1].searched, ['qa_method']);
  } finally { restore(); }
});

// 병합은 먼저 온 행을 지키므로(mergeFront) 두 번째 query 검색의 상위 적중은 새 행으로 들어오지 못한다 — 자세한
// 표시(detail)만 옮겨 받아야 그 쿼리가 다음 스텝에 입출력·SQL과 함께 보인다. 소규모 등록에서는 첫 검색이 전부를
// 실어 두 번째 검색이 새 항목을 하나도 넣지 못하므로, 옮긴 표시를 진도로 세지 않으면 검색어를 고쳐 다시 찾은
// 정당한 검색이 '새 자료 없음'으로 헛돈 스텝에 들어가 두 번이면 강제 답변으로 넘어간다.
test('두 번째 query 검색의 상위 적중은 이미 목록에 있어도 자세한 줄로 오르고, 그것을 진도로 센다', async () => {
  const restore = silence();
  try {
    const QD = (seq, name, detail) => ({ ...Q(seq, name), query_desc: `${name} 용도`, ...(detail && { detail: true }) });
    const llm = scripted([
      { action: 'search', text: '첫 검색', targets: ['query'] },
      { action: 'search', text: '둘째 검색', targets: ['query'] },   // 새 행은 없고 q3의 표시만 오른다
      { action: 'search', text: '셋째 검색', targets: ['query'] },   // 아무것도 바뀌지 않는 검색 — 첫 헛돎이어야 한다
      { action: 'answer', answer: '답' },
    ]);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ routed: false,
        queries: n++ === 0 ? [QD(1, 'q1', true), QD(2, 'q2'), QD(3, 'q3')] : [QD(3, 'q3', true), QD(1, 'q1', true), QD(2, 'q2')] }) } });
    const after = [...llm.seen[2].queries].sort((a, b) => a.query_name.localeCompare(b.query_name));
    assert.deepStrictEqual(after.map(q => [q.query_name, q.detail === true]), [['q1', true], ['q2', false], ['q3', true]]);
    assert.match(buildPrompt(llm.seen[2]).split('\n').find(l => l.startsWith('- q3')), /SQL:/, 'q3가 짧은 줄로 남았다');
    assert.equal(r.answer, '답', '표시가 오른 검색을 헛돈 스텝으로 세어 강제 답변으로 넘어갔다');
    assert.equal(r.search.searches, 3);
  } finally { restore(); }
});

test('폴백 답변은 모델이 버린 지식을 붙이지 않는다', () => {
  const a = fallbackAnswer({ history: [], knowledge: [
    { seq: 1, title: '버린 것', content: '무관한 본문', dropped: true },
    { seq: 2, title: '남긴 것', content: '관련 본문' },
  ] });
  assert.ok(!a.includes('버린 것') && !a.includes('무관한 본문'), '버린 지식이 폴백 답변에 실렸다');
  assert.ok(a.includes('남긴 것'), '남긴 지식이 버린 것에 가려졌다');
});

// 항목의 정체는 문서고 구간은 최신 검색을 따른다(mergeFront). 먼저 온 구간을 무조건 지키던 동안에는 뒤 검색이
// 같은 문서의 다른 절을 찾아도 버려졌고, 그 검색은 '새 자료 없음'으로 헛돈 스텝에 들어가 두 번이면 강제 답변이었다.
test('뒤 검색이 같은 문서의 다른 구간을 찾으면 그 구간이 같은 번호로 실리고 진도로 센다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: '설치', targets: ['knowledge'] },
      { action: 'search', text: '재시작 절차', targets: ['knowledge'] },
      { action: 'search', text: '점검', targets: ['knowledge'] },   // 같은 구간이 다시 온다 — 첫 헛돎이어야 한다
      { action: 'answer', answer: '답' },
    ]);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ knowledge: n++ === 0
        ? [CHUNK_ITEM(103, 7, 3, 3, '설치 절')]
        : [CHUNK_ITEM(115, 7, 15, 17, '재시작 절')] }) } });
    const k = llm.seen[2].knowledge;
    assert.equal(k.length, 1, '같은 문서가 두 항목으로 들어왔다');
    assert.equal(k[0].seq, 103, '모델이 지목하는 번호는 요청 내내 고정이다');
    assert.equal(k[0].content, '재시작 절', '뒤 검색이 찾은 구간이 실려야 한다');
    assert.match(firstItemLine(llm.seen[2]), /\(15~17\/22\)\]/, '프롬프트의 위치 표기가 새 구간을 가리켜야 한다');
    assert.equal(r.answer, '답', '구간이 달라진 검색을 헛돈 스텝으로 세어 강제 답변으로 넘어갔다');
    assert.equal(r.search.searches, 3);
  } finally { restore(); }
});

// 번호가 붙지 않은 항목의 청구는 프롬프트의 판정(llm-openai.js itemLine)과 같은 기준으로 거절해야 한다. 받아 주면 한
// 글자도 늘지 않는 청구가 '성공'으로 세어져 MAX_EXPANDS 하나를 먹고, 모델은 아무 안내 없이 같은 프롬프트를 다시 받는다.
test('번호가 붙지 않은 짧은 처리방법의 청구는 성공으로 세지 않고 안내를 남긴다', async () => {
  const restore = silence();
  try {
    const llm = scripted([
      { action: 'search', text: 'x', targets: ['qa_method'] },
      { action: 'expand', ids: ['m1'] },
      { action: 'answer', answer: '답' },
    ]);
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      search: async () => found({ qaMethods: [{ seq: 1, title: '짧은 방법', method: '한 줄' }, { seq: 2, title: '긴 방법', method: 'x'.repeat(2000) }] }) } });
    assert.equal(r.answer, '답');
    assert.equal(r.search.expanded, undefined, '늘지 않는 청구가 펼침으로 세어졌다');
    assert.ok(!llm.seen.at(-1).qaMethods.find(m => m.seq === 1).expanded, '짧은 항목에 펼침 표시가 붙었다');
    assert.match(r.trace.find(h => h.expand !== undefined)?.note ?? '', /번호가 붙은 항목만/, '헛돈 청구에 안내가 없다');
    // 번호가 붙은(잘린) 항목은 종전대로 펼쳐진다 — 판정이 프롬프트와 같은 기준이어야 한다.
    const llm2 = scripted([{ action: 'search', text: 'x', targets: ['qa_method'] }, { action: 'expand', ids: ['m2'] }, { action: 'answer', answer: '답' }]);
    const r2 = await handleQuestion('q', [], { deps: { decide: llm2.decide,
      search: async () => found({ qaMethods: [{ seq: 1, title: '짧은 방법', method: '한 줄' }, { seq: 2, title: '긴 방법', method: 'x'.repeat(2000) }] }) } });
    assert.equal(r2.search.expanded, 1);
  } finally { restore(); }
});

// 병합 실패 시 검색은 청크 원문을 그대로 돌려준다(search.js) — 그 행에는 구간(from·to)이 없다. 그것으로 있던 항목의
// 본문을 갈아 끼우면 위치 표기는 옛 구간을, 본문은 다른 조각을 가리켜 서로 어긋난다.
test('mergeFront는 범위를 모르는 청크 행으로 항목의 구간을 바꾸지 않는다', () => {
  const item = CHUNK_ITEM(103, 7, 3, 5, '3~5절 본문');
  const list = [item, K(9)];
  const raw = { seq: 109, doc_seq: 7, chunk_no: 9, chunk_of: 22, title: '문서7', content: '9번 조각 원문', _dist: 0.3 };
  assert.equal(mergeFront(list, [raw]), 0);
  assert.equal(item.content, '3~5절 본문');
  assert.equal(item.range, ' (3~5/22)');
  assert.deepStrictEqual(list.map(o => o.seq), [103, 9], '다시 찾은 문서는 앞으로 온다');
  // 반대 방향은 채운다 — 구간을 모르던 항목(원문 폴백)에 구간이 있는 항목이 오면 그 구간을 받는다.
  const bare = { seq: 109, doc_seq: 7, chunk_no: 9, chunk_of: 22, title: '문서7', content: '9번 조각 원문' };
  const list2 = [bare];
  assert.equal(mergeFront(list2, [CHUNK_ITEM(115, 7, 15, 17, 'B절')]), 1);
  assert.equal(bare.seq, 109);
  assert.equal(bare.range, ' (15~17/22)');
});

// 잘린 배치의 안내는 어느 상한에 걸렸는지를 말해야 한다 — 조회를 두 번밖에 안 한 요청이 이력 줄 수에 막혔는데
// '조회 스텝 상한 5회'라고 적으면 모델은 사실과 다른 이유를 받는다.
test('이력 줄 수에 막혀 잘린 배치의 안내는 조회 스텝 상한이 아니라 줄 수 상한을 말한다', async () => {
  const restore = silence();
  try {
    const decisions = [];
    for (const t of ['a', 'b', 'c']) {
      decisions.push({ action: 'search', text: t, targets: ['query'] });
      decisions.push({ action: 'search', text: t, targets: ['query'] });   // 같은 검색 — 안내 줄 하나
    }
    decisions.push({ action: 'run_query', query_name: 'q1', params: { a: 1 } });
    decisions.push({ action: 'run_query', query_name: 'q1', params: { a: 2 } });
    decisions.push({ action: 'run_queries', queries: [{ query_name: 'q1', params: { a: 3 } }, { query_name: 'q1', params: { a: 4 } }] });
    const llm = scripted(decisions);
    let n = 0;
    const r = await handleQuestion('q', [], { deps: { decide: llm.decide,
      run: async () => ({ rows: [{ V: 1 }], totalRows: 1, capped: false, targetDb: 'D' }),
      search: async () => found({ queries: [Q(++n, `q${n}`)], routed: false }) } });
    assert.equal(r.trace.length, MAX_HISTORY_ROWS);
    assert.ok(r.trace.filter(h => h.rows).length < MAX_STEPS, '이 시나리오는 조회 수 상한에 닿지 않아야 뜻이 있다');
    const note = r.trace.at(-1)?.note ?? '';
    assert.match(note, /줄 수 상한/, `줄 수에 막힌 배치가 다른 이유를 말했다: ${note}`);
    assert.ok(!/조회 스텝 상한/.test(note));
  } finally { restore(); }
});
