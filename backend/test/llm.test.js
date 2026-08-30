// 답변 조립(renderAnswer) 회귀 테스트 — 실행: npm test
// 두 곳이 같은 함수를 쓴다: Mock provider의 답변이자, 실제 LLM이 끝내 결정을 내지 못했을 때
// agent.js가 쓰는 폴백이다. 이 폴백이 없으면 조회를 세 번 성공한 요청도 'LLM 호출 실패' 한 줄로 끝난다.
// '조립할 것이 없음'을 null로 알리는 계약이 핵심이다 — 안내 문구는 두 호출부가 서로 달라야 한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { llm, renderAnswer, sanitizeDecision } from '../src/llm.js';
import { MAX_ROWS, TRUNC_MARK, MAX_BIND_LEN } from '../src/constants.js';

const ok = (name, rows, extra = {}) => ({ query_name: name, params: {}, rows, totalRows: rows.length, ...extra });

test('조립할 것이 없으면 null이다', () => {
  // 여기서 문구를 지어내면 Mock('일반 지식 없음')과 agent 폴백('LLM 호출 실패')이 같은 말을 하게 된다.
  assert.equal(renderAnswer({ knowledge: [], history: [] }), null);
});

test('조회 결과를 표로 렌더한다', () => {
  const a = renderAnswer({ knowledge: [], history: [ok('q', [{ A: 1, B: 'x' }])] });
  assert.match(a, /### q 조회 결과/);
  assert.match(a, /\| A \| B \|/);
  assert.match(a, /\| 1 \| x \|/);
});

test('셀 안의 파이프·개행·역슬래시가 표를 무너뜨리지 않는다', () => {
  // 역슬래시를 먼저 이스케이프하지 않으면 'C:\|share'가 GFM에서 살아 있는 구분자가 된다.
  const a = renderAnswer({ knowledge: [], history: [ok('q', [{ A: 'C:\\|share', B: '한\n줄' }])] });
  assert.ok(a.includes('C:\\\\\\|share'), a);
  assert.ok(!a.split('\n').some(l => l.includes('한') && l.includes('줄') === false));
  assert.ok(a.includes('한 줄'), '개행은 공백으로 바뀌어야 한다');
});

test('조회 0건과 조회 실패를 구분해 알린다', () => {
  assert.match(renderAnswer({ knowledge: [], history: [ok('q', [])] }), /조회 결과가 없습니다/);
  assert.match(
    renderAnswer({ knowledge: [], history: [{ query_name: 'q', params: {}, error: '조회대상 DB를 찾을 수 없음: X', safe: true }] }),
    /실행 오류: 조회대상 DB를 찾을 수 없음: X/
  );
});

test('safe 표시가 없는 오류 원문은 답변에 싣지 않는다', () => {
  // 이 답변은 사용자에게 그대로 나간다 — 드라이버 원문(스키마명·호스트)은 화면 trace(server.js)와
  // 같은 기준으로 숨긴다. 원문은 로그와 chat_log에만 남는다.
  const a = renderAnswer({ knowledge: [], history: [{ query_name: 'q', params: {}, error: 'ORA-00942: "APP_USER"."SECRET"' }] });
  assert.ok(!a.includes('ORA-00942'), a);
  assert.match(a, /조회 중 오류가 발생했습니다/);
});

test('생략 건수와 조회 상한 도달을 구분해 알린다', () => {
  const rows = new Array(20).fill({ A: 1 });
  assert.match(renderAnswer({ knowledge: [], history: [ok('q', rows, { totalRows: 50 })] }), /외 30건 생략 \(총 50건\)/);
  const capped = renderAnswer({ knowledge: [], history: [ok('q', rows, { totalRows: MAX_ROWS, capped: true })] });
  assert.match(capped, /이상 생략/);
  assert.match(capped, new RegExp(`조회 상한 ${MAX_ROWS}건 도달`));
});

test('조회가 성공했으면 결과 값과 겹치는 지식만 첨부한다', () => {
  // 무조건 첨부하면 "BATCH999는 없습니다" 뒤에 존재하지도 않는 작업의 재시작 절차가 붙는다.
  const knowledge = [{ title: '재시작', content: 'FAILED 상태이면 재시작한다' }];
  assert.match(renderAnswer({ knowledge, history: [ok('q', [{ STATUS: 'FAILED' }])] }), /관련 지식: 재시작/);
  assert.doesNotMatch(renderAnswer({ knowledge, history: [ok('q', [])] }), /관련 지식/);
});

test('조회가 전부 실패했으면 지식을 첨부한다', () => {
  // 손에 든 지식 대신 드라이버 오류 문구만 남으면 안 된다.
  const knowledge = [{ title: '재시작', content: 'FAILED 상태이면 재시작한다' }];
  const a = renderAnswer({ knowledge, history: [{ query_name: 'q', params: {}, error: 'ORA-12541' }] });
  assert.match(a, /관련 지식: 재시작/);
});

test('한 글자 값은 지식 매칭에 쓰지 않는다', () => {
  // ''는 모든 문자열에 포함되고, 'Y'·등급 'A'는 어지간한 한국어 본문에 다 들어 있다.
  const knowledge = [{ title: '무관', content: '가나다라마바사' }];
  assert.equal(renderAnswer({ knowledge, history: [ok('q', [{ FLAG: '가', EMPTY: '' }])] }).includes('관련 지식'), false);
});

test('잘린 셀 표시가 붙은 값도 그대로 렌더한다', () => {
  // 표시는 하되 바인드로 되돌리지 않는 것은 llm.js valueFromHistory의 몫이다.
  const a = renderAnswer({ knowledge: [], history: [ok('q', [{ A: `본문${TRUNC_MARK}` }])] });
  assert.ok(a.includes(TRUNC_MARK));
});

// ===== 결정 경계 (sanitizeDecision) =====
// LLM이 만든 query_name·params는 이대로 history에 기록되어 프롬프트·chat_log·화면 trace로
// 흘러간다 — 경계가 뚫리면 값 하나가 프롬프트 예산을 넘겨 남은 모든 LLM 호출이 실패한다.

test('결정 경계가 거대한 바인드 값을 자르고 잘렸음을 표시한다', () => {
  const d = sanitizeDecision({
    action: 'run_query',
    query_name: ' q1\n',
    params: { a: 'x'.repeat(MAX_BIND_LEN + 1000), n: 7, z: null },
  });
  assert.equal(d.query_name, 'q1', '이름 앞뒤 공백은 등록 철자 비교를 어긋내므로 제거한다');
  assert.ok(d.params.a.length <= MAX_BIND_LEN + TRUNC_MARK.length);
  assert.ok(d.params.a.endsWith(TRUNC_MARK), '잘린 값은 바인드 가드가 거부하도록 표시가 남아야 한다');
  assert.equal(d.params.n, 7);
  assert.equal(d.params.z, null);
});

test('정상 크기의 결정은 값이 그대로 통과한다', () => {
  const d = { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } };
  assert.deepStrictEqual(sanitizeDecision(d), d);
  // answer 결정과 무결정(null)은 손대지 않는다
  const a = { action: 'answer', answer: '답' };
  assert.strictEqual(sanitizeDecision(a), a);
  assert.strictEqual(sanitizeDecision(null), null);
});

test('프로토타입 멤버와 겹치는 바인드명이 Mock 결정을 죽이지 않는다', async () => {
  // PARAM_RULES[name]·params[name] 접근이 프로토타입 체인을 타면 결정 루프 전체가 죽어
  // 매 스텝 무결정 → 사용자는 'LLM 호출 실패'만 본다. 소유 키 기준으로 무해해야 한다.
  delete process.env.LLM_PROVIDER; // mock 경로
  const d = await llm.decide({
    question: '"V1" 값으로 조회',
    chat: [],
    knowledge: [],
    qaMethods: [{ seq: 1, title: 't', method: 'proto_query 실행' }],
    queries: [{ seq: 1, query_name: 'proto_query', query_sql: 'SELECT 1 FROM t WHERE a = :__proto__' }],
    history: [],
  });
  assert.equal(d.action, 'run_query');
  assert.ok(Object.hasOwn(d.params, '__proto__'), '값이 소유 키로 채워져야 한다 (대입은 setter를 타고 사라진다)');
  assert.equal(d.params['__proto__'], 'V1'); // 따옴표 fallback으로 채워진 값
});
