// 답변 조립(renderAnswer) 회귀 테스트 — 실행: npm test
// 두 곳이 같은 함수를 쓴다: Mock provider의 답변이자, 실제 LLM이 끝내 결정을 내지 못했을 때
// agent.js가 쓰는 폴백이다. 이 폴백이 없으면 조회를 세 번 성공한 요청도 'LLM 호출 실패' 한 줄로 끝난다.
// '조립할 것이 없음'을 null로 알리는 계약이 핵심이다 — 안내 문구는 두 호출부가 서로 달라야 한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { llm, renderAnswer, sanitizeDecision, llmProvider } from '../src/llm.js';
import { MAX_ROWS, TRUNC_MARK, MAX_BIND_LEN, MAX_ANSWER_LEN } from '../src/constants.js';

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

test('행마다 컬럼이 달라도 값이 표에서 사라지지 않는다', () => {
  // 첫 행만 보고 컬럼을 정하면 뒤 행에만 있는 값이 조용히 빠진다 — 오류가 남지 않아
  // 답변을 읽는 쪽에서는 그 컬럼이 '없다'로 읽힌다.
  const a = renderAnswer({ knowledge: [], history: [ok('q', [{ A: 1 }, { A: 2, B: 'x' }])] });
  assert.match(a, /\| A \| B \|/, '컬럼은 모든 행의 합집합이어야 한다');
  assert.match(a, /\| 1 \|\s+\|/, '없는 컬럼은 빈 칸으로 채운다');
  assert.match(a, /\| 2 \| x \|/);
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

test('결정 경계가 거대한 answer도 자르고 잘렸음을 알린다', () => {
  // 결정에 실려 오는 세 값 중 answer만 상한이 없었다 — query_name(200자)·params(MAX_BIND_LEN)를
  // 묶으면서 정작 가장 큰 값이 그대로 통과해 응답 JSON과 chat_log.answer로 두 번 직렬화됐다.
  // 조용히 자르면 끊긴 문장을 답변의 끝으로 읽으므로 표시를 남긴다.
  const d = sanitizeDecision({ action: 'answer', answer: 'ㄱ'.repeat(MAX_ANSWER_LEN + 1000) });
  assert.ok(d.answer.length < MAX_ANSWER_LEN + 100, `상한을 넘겼다: ${d.answer.length}`);
  assert.match(d.answer, /생략했습니다/, '잘린 사실이 사용자에게 보여야 한다');
});

test('앞부분이 같은 긴 바인드명이 서로를 지우지 않는다', () => {
  // 이름을 자른 뒤 fromEntries로 조립하면 겹친 키가 하나로 뭉개져 다른 바인드의 값이 통째로
  // 사라진다 — 크기를 확정해야 할 경계가 데이터를 버리는 셈이고, 사라진 쪽은 실행 단계에서
  // '값 없음'으로 실패해 원인이 엉뚱한 곳(모델이 값을 안 줬다)으로 읽힌다.
  const head = 'a'.repeat(200);
  const d = sanitizeDecision({
    action: 'run_query', query_name: 'q', params: { [`${head}X`]: 'v1', [`${head}Y`]: 'v2' },
  });
  assert.equal(Object.keys(d.params).length, 2, '서로 다른 바인드가 한 키로 뭉개졌다');
  assert.deepStrictEqual(Object.values(d.params).sort(), ['v1', 'v2']);
});

test('정상 크기의 결정은 값이 그대로 통과한다', () => {
  const d = { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } };
  assert.deepStrictEqual(sanitizeDecision(d), d);
  // answer 결정과 무결정(null)은 손대지 않는다
  const a = { action: 'answer', answer: '답' };
  assert.strictEqual(sanitizeDecision(a), a);
  assert.strictEqual(sanitizeDecision(null), null);
});

test('provider 이름의 대소문자·공백을 흡수하고 모르는 값은 소리 나게 알린다', () => {
  // 정확한 일치만 보면 'OpenAI'·'openai '가 조용히 Mock으로 떨어진다. Mock도 지식과 조회 표를
  // 그럴듯하게 렌더하므로 답변만 봐서는 구분되지 않고, 기동 배너·접속정보 누락 검사도 같은
  // 비교를 쓰던 탓에 함께 비켜갔다 — 로그가 유일한 단서라 경고까지 함께 못 박는다.
  const saved = process.env.LLM_PROVIDER;
  const warned = [];
  const origWarn = console.warn;
  console.warn = m => warned.push(String(m));
  try {
    for (const v of ['openai', 'OpenAI', ' openai ', 'OPENAI']) {
      process.env.LLM_PROVIDER = v;
      assert.equal(llmProvider(), 'openai', v);
    }
    for (const v of ['mock', 'Mock', '', '   ']) {
      process.env.LLM_PROVIDER = v;
      assert.equal(llmProvider(), 'mock', v);
    }
    delete process.env.LLM_PROVIDER;
    assert.equal(llmProvider(), 'mock', '미설정은 mock이 기본이다');
    // 모르는 값은 Mock으로 떨어지되 반드시 경고가 남아야 한다.
    warned.length = 0;
    process.env.LLM_PROVIDER = 'vllm';
    assert.equal(llmProvider(), 'mock');
    assert.ok(warned.some(m => /LLM_PROVIDER/.test(m)), '모르는 값에 경고가 없다');
  } finally {
    console.warn = origWarn;
    if (saved === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = saved;
  }
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

// ===== Mock provider의 후속 질문 처리 (fillParams / PARAM_RULES) =====
// 규칙이 좁으면 '못 뽑는다'로 끝나지 않는다: 현재 질문에서 못 뽑으면 이전 질문으로 넘어가므로,
// 대상만 바꿔 묻는 후속 질문이 직전 대상의 결과로 답변된다. 조회는 성공하고 표까지 붙어서
// 사용자도 chat_log도 그것이 다른 사람의 답이라는 사실을 알 수 없다.

const CUSTOMER_CTX = {
  knowledge: [],
  qaMethods: [{ seq: 1, title: '고객 주문 상태 확인', method: 'find_customer_id 쿼리로 고객명(:customer_name)을 조회한다' }],
  queries: [{ seq: 1, query_name: 'find_customer_id', query_sql: 'SELECT CUSTOMER_ID FROM CUSTOMERS WHERE CUSTOMER_NAME = :customer_name' }],
  history: [],
};

test('후속 질문의 새 대상이 직전 질문의 대상으로 덮이지 않는다', async () => {
  delete process.env.LLM_PROVIDER; // mock 경로
  const d = await llm.decide({
    ...CUSTOMER_CTX,
    question: '그럼 김철수는?',
    chat: [{ role: 'user', text: '홍길동 고객 주문 상태 알려줘' }, { role: 'assistant', text: '(표)' }],
  });
  assert.equal(d.action, 'run_query');
  assert.equal(d.params.customer_name, '김철수', '직전 대상(홍길동)의 결과로 답변되고 있었다');
});

test('이름에 붙은 표지를 그대로 쓰던 형태도 계속 읽는다', async () => {
  delete process.env.LLM_PROVIDER;
  for (const [question, expected] of [
    ['홍길동 고객 주문 상태 알려줘', '홍길동'],
    ['이영희님 주문 알려줘', '이영희'],
    ['김철수의 주문 상태는?', '김철수'],
  ]) {
    const d = await llm.decide({ ...CUSTOMER_CTX, question, chat: [] });
    assert.equal(d.params.customer_name, expected, question);
  }
});

test('현재 질문이 대상을 말하지 않을 때만 직전 질문에서 가져온다', async () => {
  // 후속 질문 처리의 존재 이유 — 이 폴백까지 막으면 "재시작은 어떻게 해?"가 대상을 잃는다
  delete process.env.LLM_PROVIDER;
  const d = await llm.decide({
    knowledge: [],
    qaMethods: [{ seq: 1, title: '배치 상태', method: 'batch_job_status 쿼리를 실행한다' }],
    queries: [{ seq: 1, query_name: 'batch_job_status', query_sql: 'SELECT STATUS FROM BATCH_JOBS WHERE JOB_ID = :job_id' }],
    history: [],
    question: '재시작은 어떻게 해?',
    chat: [{ role: 'user', text: '그럼 BATCH002는?' }, { role: 'assistant', text: '(표)' }],
  });
  assert.equal(d.params.job_id, 'BATCH002');
});
