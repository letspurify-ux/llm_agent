// 답변 조립(renderAnswer) 회귀 테스트 — 실행: npm test
// 두 곳이 같은 함수를 쓴다: Mock provider의 답변이자, 실제 LLM이 끝내 결정을 내지 못했을 때
// agent.js가 쓰는 폴백이다. 이 폴백이 없으면 조회를 세 번 성공한 요청도 'LLM 호출 실패' 한 줄로 끝난다.
// '조립할 것이 없음'을 null로 알리는 계약이 핵심이다 — 안내 문구는 두 호출부가 서로 달라야 한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { llm, renderAnswer, sanitizeDecision, llmProvider } from '../src/llm.js';
import { normalizeCells } from '../src/oracle.js';
import { MAX_ROWS, MAX_CELL_LEN, TRUNC_MARK, MAX_BIND_LEN, MAX_ANSWER_LEN, MAX_BIND_NAME_LEN } from '../src/constants.js';

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

test('홀로 선 CR도 개행이다 — 잘린 CRLF 셀이 표의 행을 가르지 않는다', () => {
  // CommonMark는 \r 하나도 줄 끝으로 읽는다(remark-gfm로 실측: `| x\ry | b1 |`이 두 행으로 갈라져
  // 'y'가 다음 행의 첫 칸이 되고 뒤 칸의 값이 밀렸다). `\r?\n`만 바꾸면 이 CR이 그대로 나간다.
  // 실제 경로: CRLF를 담은 텍스트 셀을 oracle.js normalizeCells가 MAX_CELL_LEN에서 자르면 \r만 남는다.
  const clipped = normalizeCells({ A: 'a'.repeat(MAX_CELL_LEN - 1) + '\r\nb' }).A;
  assert.ok(clipped.endsWith('\r' + TRUNC_MARK), '전제: 드라이버 경계가 CRLF 한가운데를 자를 수 있다');
  const a = renderAnswer({ knowledge: [], history: [ok('q', [{ A: clipped, B: 'b1' }, { A: 'x\ry', B: 'b2' }])] });
  assert.ok(!a.includes('\r'), '표에 CR이 남으면 그 행이 둘로 갈라진다');
  assert.ok(a.split('\n').some(l => l.includes(TRUNC_MARK) && l.endsWith('| b1 |')), a);
  assert.match(a, /\| x y \| b2 \|/);
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
  // 줄 중간·코드펜스 안에서 자르지 않는다 — 반 토막 난 표 행은 잘린 숫자가 값으로 읽히고(차트는 그것을 그린다),
  // 열린 펜스는 안내 문장까지 코드로 삼킨다
  const row = i => `| 2024-${String(i % 12 + 1).padStart(2, '0')} | ${100000 + i} |`;
  const rows = Array.from({ length: Math.ceil(MAX_ANSWER_LEN / 20) }, (_, i) => row(i)).join('\n');
  const t = sanitizeDecision({ action: 'answer', answer: `앞 문장\n\n\`\`\`chart\ntype: line\ntitle: 월별\n| 월 | 건수 |\n|---|---|\n${rows}\n\`\`\`\n\n뒤 문장` }).answer;
  const lines = t.split('\n');
  const note = lines.length - 1; // 마지막 줄이 안내 문장, 그 앞은 빈 줄, 그 앞이 닫는 펜스
  assert.match(lines[note], /생략했습니다/);
  assert.strictEqual(lines[note - 2], '```');
  assert.ok(lines.slice(7, note - 2).every(l => /^\| 2024-\d\d \| 1\d{5} \|$/.test(l)), '표 행은 모두 온전해야 한다');
  assert.ok(t.length <= MAX_ANSWER_LEN + 100);
});

test('잘린 답변의 펜스 닫기는 markdown 규칙을 따른다 — ~~~ 펜스, ```` 안의 ``` 줄, 인라인 코드', () => {
  // ``` 줄의 짝만 세던 때에는(실측) ~~~chart 블록과 ````chart 안에 ``` 줄이 든 블록이 잘리면 닫히지 않아
  // 안내 문장이 차트 본문으로 들어갔고(프런트는 표가 아닌 줄을 버리므로 잘린 사실이 화면에서 사라진다),
  // ```a``` 같은 인라인 코드 줄은 펜스로 세어져 멀쩡한 답변 끝에 빈 펜스를 열었다.
  const rows = Array.from({ length: Math.ceil(MAX_ANSWER_LEN / 20) }, (_, i) => `| 2024-01 | ${100000 + i} |`).join('\n');
  const cut = answer => sanitizeDecision({ action: 'answer', answer }).answer.split('\n').slice(-3);
  const note = /생략했습니다/;
  let t = cut(`~~~chart\ntype: line\n| 월 | 건수 |\n|---|---|\n${rows}\n~~~\n\n뒤`);
  assert.strictEqual(t[0], '~~~'); assert.match(t[2], note);
  t = cut(`\`\`\`\`chart\ntype: line\n\`\`\`\n| 월 | 건수 |\n|---|---|\n${rows}\n\`\`\`\`\n\n뒤`);
  assert.strictEqual(t[0], '````'); assert.match(t[2], note);
  t = cut(`~~~chart\r\ntype: line\r\n${rows.replaceAll('\n', '\r\n')}\r\n~~~\r\n`); // CRLF도 chart.js와 같이 받는다
  assert.strictEqual(t[0], '~~~'); assert.match(t[2], note);
  // 닫힌 블록 뒤·인라인 코드 뒤에서 잘리면 펜스를 덧붙이지 않는다
  t = cut(`\`\`\`sql\nselect 1\n\`\`\`\n\n\`\`\`a\`\`\` 인라인\n\n${'글\n'.repeat(MAX_ANSWER_LEN)}`);
  assert.strictEqual(t[0], '글'); assert.match(t[2], note);
});

test('바인드로 쓸 수 없는 긴 이름은 뭉개거나 개명하지 않고 버린다', () => {
  // 이름을 자르면 두 방향 모두로 깨진다. 그냥 자르면 앞부분이 같은 두 이름이 한 키로 뭉개져
  // 다른 바인드의 값이 사라지고, 뭉개짐을 피하려 순번을 붙이면(base~2) 그 이름은 ① '~'가
  // 바인드명 문자가 아니라 어떤 실제 바인드와도 매칭되지 않고 ② 130자라 이 경계가 지키기로 한
  // 128자 상한을 스스로 넘는다 — 어느 쪽이든 값은 실행 단계에서 똑같이 사라진다.
  // 애초에 128자(Oracle 식별자 상한)를 넘는 이름은 어떤 등록 SQL의 바인드와도 대응할 수 없다.
  // 자르지 않고 버리는 것이 정직하고, 그러면 뭉개짐이 생길 여지 자체가 없어진다.
  const head = 'a'.repeat(200);
  const d = sanitizeDecision({
    action: 'run_query',
    query_name: 'q',
    params: { [`${head}X`]: 'v1', [`${head}Y`]: 'v2', job_id: 'BATCH001' },
  });
  assert.deepStrictEqual(d.params, { job_id: 'BATCH001' }, '실행 가능한 바인드만 남아야 한다');
  // 경계가 스스로 불법인 이름을 만들어내지 않는다 — 남은 키는 전부 상한 이하다
  assert.ok(Object.keys(d.params).every(k => k.length <= 128), '경계가 상한을 넘는 이름을 만들었다');
  // 128자짜리 '적법한' 이름은 손대지 않는다 (그보다 짧게 자르면 반드시 '값 없음'으로 실패한다)
  const legal = 'b'.repeat(128);
  const ok = sanitizeDecision({ action: 'run_query', query_name: 'q', params: { [legal]: 'v' } });
  assert.deepStrictEqual(Object.keys(ok.params), [legal]);
});

test('바인드 키 앞의 콜론은 표기로 보고 뗀다', () => {
  // 프롬프트는 바인드를 SQL 표기 그대로(':job_id') 보여주므로 모델이 키를 ":job_id"로 적는 일이
  // 실제로 있다. 실행 경계의 이름 대조(constants.bindValue)는 콜론을 모르므로 값을 정확히 채우고도
  // '값 없음'으로 실패하고, hint는 값을 확인하라고만 해서 모델은 같은 키로 다시 시도한다.
  const d = sanitizeDecision({ action: 'run_query', query_name: 'q', params: { ':job_id': 'BATCH001', ':n': 7 } });
  assert.deepStrictEqual(d.params, { job_id: 'BATCH001', n: 7 });
  // 뗀 뒤 겹치면 먼저 적은 값을 남긴다 — fromEntries에 맡기면 나중 것이 이긴다
  const dup = sanitizeDecision({ action: 'run_query', query_name: 'q', params: { ':a': 'first', a: 'second' } });
  assert.deepStrictEqual(dup.params, { a: 'first' });
  // 콜론을 뗀 뒤의 길이로 상한을 재야 128자짜리 적법한 이름이 ':' 하나 때문에 버려지지 않는다
  const legal = 'b'.repeat(MAX_BIND_NAME_LEN);
  const ok = sanitizeDecision({ action: 'run_query', query_name: 'q', params: { [`:${legal}`]: 'v' } });
  assert.deepStrictEqual(Object.keys(ok.params), [legal]);
  // 앞의 콜론 하나만이다 — 이름 안의 콜론은 모델이 지어낸 이름이므로 손대지 않는다 (어차피 매칭되지 않는다)
  const inner = sanitizeDecision({ action: 'run_query', query_name: 'q', params: { 'a:b': 1, '::c': 2 } });
  assert.deepStrictEqual(inner.params, { 'a:b': 1, ':c': 2 });
});

test('결정 경계는 객체가 아닌 params를 빈 것으로 본다', () => {
  // Object.entries는 문자열도 받는다 — 'job_id=1'이 {0:'j',1:'o',…}가 되어 그대로 history·프롬프트에
  // 실리고, 모델은 자기가 낸 적 없는 params를 보게 된다. 배열도 같은 경로로 {0:'…'}가 된다.
  for (const params of ['job_id=1', ['BATCH001'], 7, true, null, undefined]) {
    const d = sanitizeDecision({ action: 'run_query', query_name: 'q', params });
    assert.deepStrictEqual(d.params, {}, JSON.stringify(params));
  }
});

test('정상 크기의 결정은 값이 그대로 통과한다', () => {
  const d = { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } };
  assert.deepStrictEqual(sanitizeDecision(d), d);
  // answer 결정과 무결정(null)은 손대지 않는다
  const a = { action: 'answer', answer: '답' };
  assert.strictEqual(sanitizeDecision(a), a);
  assert.strictEqual(sanitizeDecision(null), null);
  // 상한 아래면 answer의 타입도 그대로 둔다. 이 경계의 일은 '크기 확정'이지 타입 정규화가 아니다 —
  // 문자열로 굳히면 falsy였던 값(0·false)이 truthy가 되면서, 폴백으로 가야 할 결정이
  // "0"이라는 답변으로 화면에 나간다 (agent.js는 answer의 truthy 여부로 폴백을 판단한다).
  for (const v of [0, false, null, undefined, 42]) {
    const d = { action: 'answer', answer: v };
    assert.strictEqual(sanitizeDecision(d), d, `answer: ${JSON.stringify(v)}`);
  }
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
  // 이름은 'constructor'로 잡는다 — '__proto__'는 영문자로 시작하지 않아 Oracle이 바인드로
  // 받지 않고(ORA-01745) sql.js 가드가 등록 단계에서 먼저 거부하므로 이 경로에 닿지 못한다.
  // 실제로 이 판정이 필요한 이름은 constructor·toString·valueOf처럼 전부 적법한 식별자다.
  delete process.env.LLM_PROVIDER; // mock 경로
  const d = await llm.decide({
    question: '"V1" 값으로 조회',
    chat: [],
    knowledge: [],
    qaMethods: [{ seq: 1, title: 't', method: 'proto_query 실행' }],
    queries: [{ seq: 1, query_name: 'proto_query', query_sql: 'SELECT 1 FROM t WHERE a = :constructor' }],
    history: [],
  });
  assert.equal(d.action, 'run_query');
  assert.ok(Object.hasOwn(d.params, 'constructor'), '값이 소유 키로 채워져야 한다 (대입은 setter를 타고 사라진다)');
  assert.equal(d.params.constructor, 'V1'); // 따옴표 fallback으로 채워진 값
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

test('본문이 NULL이어도 폴백 답변이 죽지 않는다', () => {
  // renderAnswer는 agent.js의 fallbackAnswer이기도 하다 — 여기서 던지면 handleQuestion을
  // 빠져나가 /api/chat의 catch가 잡고 500이 나가면서, 이미 성공한 Oracle 조회 결과까지 통째로
  // 버려진다. 이 폴백이 존재하는 이유('그 요청이 실제로 한 일이 통째로 사라지고')를 정확히
  // 뒤집는 결과다. 지금은 schema.sql의 NOT NULL만이 유일한 방어막이라, 컬럼 하나가 완화되거나
  // 임포터가 NULL 행을 넣는 것만으로 그 경로가 열린다 — 다른 소비자는 전부 NULL을 견딘다.
  const a = renderAnswer({
    knowledge: [{ title: null, content: null }],
    history: [{ query_name: 'q', params: {}, rows: [{ A: 'FAILED' }], totalRows: 1 }],
  });
  assert.match(a, /FAILED/, '조회 결과가 남아야 한다');

  // 조회가 하나도 없으면 지식을 무조건 첨부하는 경로도 같은 값을 지나간다
  assert.doesNotThrow(() => renderAnswer({ knowledge: [{ title: null, content: null }], history: [] }));
});

test('qa_method 본문이 NULL이어도 Mock 실행 계획이 죽지 않는다', async () => {
  // plannedQueries의 m.method.toLowerCase()가 던지면 결정 루프가 통째로 죽어
  // 사용자는 'LLM 호출 실패'만 본다 (renderAnswer와 같은 이유·같은 방어).
  delete process.env.LLM_PROVIDER; // mock 경로
  const d = await llm.decide({
    question: '상태 알려줘',
    chat: [],
    knowledge: [],
    qaMethods: [{ seq: 1, title: 't', method: null }],
    queries: [{ seq: 1, query_name: 'q', query_sql: 'SELECT 1 FROM t' }],
    history: [],
  });
  assert.equal(d.action, 'answer');
});

test('대문자로 등록된 바인드명도 Mock 규칙이 걸린다', async () => {
  // 바인드명은 대소문자를 구분하지 않는데(constants.bindValue, sql.js bindNames) PARAM_RULES 조회만
  // 정확한 철자를 요구하면, 컬럼명에 맞춰 `WHERE JOB_ID = :JOB_ID`로 등록한 쿼리에서 규칙이 걸리지
  // 않는다. fillParams가 null을 돌려주고 mockDecide는 그 쿼리를 '무관한 쿼리'로 건너뛴다 —
  // 조회 없이 답이 나가는데 왜 건너뛰었는지는 어디에도 남지 않는다. 가장 나쁜 부류의 실패다.
  const saved = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'mock';
  try {
    for (const bind of [':job_id', ':JOB_ID', ':Job_Id']) {
      const d = await llm.decide({
        question: 'BATCH001 상태 알려줘', chat: [], knowledge: [], history: [],
        qaMethods: [{ title: 'm', method: 'batch_job_status 를 실행한다' }],
        queries: [{ query_name: 'batch_job_status', query_sql: `SELECT * FROM T WHERE JOB_ID = ${bind}`,
                    target_db_name: 'D', query_desc: '', input_desc: '', output_desc: '' }],
      });
      assert.equal(d.action, 'run_query', `${bind}: 조회가 조용히 생략됐다`);
      assert.equal(Object.values(d.params)[0], 'BATCH001', bind);
    }
  } finally {
    if (saved === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = saved;
  }
});
