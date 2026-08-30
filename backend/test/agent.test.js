// 결정 루프 가드 회귀 테스트 — 실행: npm test
// 이 판정은 양쪽 방향 모두로 '조용히' 깨진다.
//   느슨해지면 — 퇴화한 LLM 응답이 제자리를 돌며 스텝과 Oracle 조회를 소진한다.
//   빡빡해지면 — 다단계 절차의 정상 흐름이 '이미 실행된 쿼리'로 끊겨 답변만 부실해진다.
// 어느 쪽도 오류를 남기지 않아 로그로는 알 수 없다. 테스트가 유일한 방어선이다.
import { test } from 'node:test';
import assert from 'node:assert';
import { loopGuard, paramKey, normalizeChat, truncatedBinds } from '../src/agent.js';
import { MAX_CHAT_TURNS, MAX_CHAT_LEN, TRUNC_MARK } from '../src/constants.js';

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

// ===== 잘린 셀 값 가드 (truncatedBinds) =====
// 잘린 값을 바인드하면 조용히 0건이 나오고 모델은 그것을 "그런 데이터가 없다"로 읽는다 —
// 반대로 넓게 막으면 질문에서 온 정당한 긴 값이 영구히 거부된다. 양쪽 다 오류가 남지 않는다.

test('이력의 잘린 셀에서 마크를 뗀 값은 바인드로 쓰지 못한다', () => {
  const history = [ran('q1', {}, [{ BODY: `앞부분${TRUNC_MARK}`, ID: 'A1' }])];
  assert.deepStrictEqual(truncatedBinds(history, ['key'], { key: '앞부분' }), ['key']);
});

test('잘린 셀과 무관한 값은 통과한다', () => {
  const history = [ran('q1', {}, [{ BODY: `앞부분${TRUNC_MARK}` }])];
  assert.deepStrictEqual(truncatedBinds(history, ['key'], { key: '다른값' }), []);
  // 질문에서 온 정당한 긴 값 — 길이만으로 거부하면 이 입력으로는 그 쿼리를 영영 실행할 수 없다
  assert.deepStrictEqual(truncatedBinds(history, ['key'], { key: 'x'.repeat(300) }), []);
  // 이력에 잘린 셀이 없으면 아무것도 걸리지 않는다
  assert.deepStrictEqual(truncatedBinds([], ['key'], { key: '앞부분' }), []);
  // 온전한 셀 값(마크가 그대로 붙은 값)은 여기 몫이 아니다 — bindProblem(oracle.js)이 거부한다
  assert.deepStrictEqual(truncatedBinds(history, ['key'], { key: 7 }), []);
});

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
