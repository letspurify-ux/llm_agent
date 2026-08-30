// 프롬프트 길이 예산 회귀 테스트 — 실행: npm test
// 이 예산은 어긋나도 티가 나지 않는다: 등록 내용이 평범한 동안에는 예산에 닿지도 않다가,
// 긴 문서나 컬럼 많은 조회가 들어온 날부터 '모든 질문이 LLM 호출 실패'가 된다.
// 실제로 두 방향 모두로 어긋나 있었다 — 섹션 상한 합계가 문서(36k)와 달랐고(44k),
// 가장 큰 페이로드인 실행 이력에는 상한이 아예 없었다.
import { test } from 'node:test';
import assert from 'node:assert';
import { buildPrompt } from '../src/llm-openai.js';
import { MAX_PROMPT_TOTAL_LEN, PROMPT_FLOORS, MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_QUESTION_LEN } from '../src/constants.js';

const big = n => 'ㄱ'.repeat(n);

const ctx = (over = {}) => ({
  question: '질문', chat: [], knowledge: [], qaMethods: [], queries: [], history: [], ...over,
});

// 컬럼 수는 등록 SQL이 정하므로 상한이 없다 — 셀 길이(200자)만 드라이버 경계가 묶는다.
const wideRows = (rows, cols) =>
  new Array(rows).fill(0).map((_, r) =>
    Object.fromEntries(new Array(cols).fill(0).map((__, c) => [`COL_${c}`, `${r}-${big(200)}`])));

const knowledge = n => new Array(n).fill(0).map((_, i) => ({ seq: i, title: `지식${i}`, content: big(5000) }));
const methods = n => new Array(n).fill(0).map((_, i) => ({ seq: i, title: `방법${i}`, method: big(5000) }));
const queries = n => new Array(n).fill(0).map((_, i) => ({
  seq: i, query_name: `q${i}`, query_desc: big(3000), input_desc: big(3000),
  output_desc: big(3000), query_sql: `SELECT ${big(3000)} FROM t WHERE a = :a`, target_db_name: 'D',
}));

// 대화·질문은 이 예산 밖이다(각자 다른 상한으로 이미 묶여 있다) — 그 몫만큼 여유를 둔다.
const OUTSIDE_BUDGET = MAX_CHAT_TURNS * MAX_CHAT_LEN + MAX_QUESTION_LEN;

test('한 섹션이 아무리 길어도 프롬프트 전체가 예산을 넘지 않는다', () => {
  // 네 섹션이 동시에 예산을 꽉 채우는 최악 — 예전에는 섹션마다 독립 상한이라 합계가 그대로 더해졌다
  const p = buildPrompt(ctx({
    knowledge: knowledge(30),
    qaMethods: methods(30),
    queries: queries(35),
    history: new Array(5).fill(0).map((_, i) => ({
      query_name: `q${i}`, params: { a: 1 }, rows: wideRows(20, 30), totalRows: 100, capped: true,
    })),
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length} > ${MAX_PROMPT_TOTAL_LEN}`);
});

test('실행 이력만으로도 예산을 넘지 못한다', () => {
  // 이력에 상한이 없던 시절의 실패 형태: 컬럼 30개짜리 조회 한 번이 한 스텝에 12만 자를 실었다.
  const p = buildPrompt(ctx({
    history: [{ query_name: 'wide', params: {}, rows: wideRows(20, 30), totalRows: 20 }],
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `이력이 예산을 넘었다: ${p.length}`);
});

test('잘린 행은 유효한 JSON으로 남고 건수를 정직하게 알린다', () => {
  // JSON 문자열을 중간에서 자르면 모델이 그 조각을 값으로 읽어 바인드로 되돌린다.
  const p = buildPrompt(ctx({
    history: [{ query_name: 'wide', params: {}, rows: wideRows(20, 30), totalRows: 20 }],
  }));
  const json = p.slice(p.lastIndexOf(': [') + 2); // 이력 줄의 마지막 조각이 행 JSON이다
  const parsed = JSON.parse(json); // 조각이면 여기서 던진다
  assert.ok(parsed.length >= 1 && parsed.length < 20, `행이 줄어야 한다: ${parsed.length}`);
  assert.match(p, new RegExp(`총 20건 중 처음 ${parsed.length}건만 표시`));
});

test('최신 스텝을 남기고 오래된 스텝부터 버린다', () => {
  // 꼬리부터 버리면 방금 조회한 결과가 먼저 사라져 그 스텝이 통째로 헛수고가 된다.
  const history = new Array(5).fill(0).map((_, i) => ({
    query_name: `step${i}`, params: {}, rows: wideRows(20, 20), totalRows: 20,
  }));
  const p = buildPrompt(ctx({ history }));
  assert.ok(p.includes('step4'), '가장 최신 스텝이 남아야 한다');
  assert.ok(p.includes('프롬프트 길이 제한으로 생략'), '버린 사실을 모델에게 알려야 한다');
  // 시간순 표시는 유지된다
  assert.ok(p.indexOf('step3') < p.indexOf('step4') || !p.includes('step3'));
});

test('앞 섹션이 짧으면 그 여유가 쿼리 목록으로 넘어간다', () => {
  // 배분이 '섹션마다 고정'이면 지식이 비어 있어도 쿼리 목록은 최소 몫에 묶인다.
  const only = buildPrompt(ctx({ queries: queries(35) }));
  const withNoise = buildPrompt(ctx({ queries: queries(35), knowledge: knowledge(30), qaMethods: methods(30) }));
  const countQueries = s => (s.match(/^- q\d+: /gm) || []).length;
  assert.ok(countQueries(only) > PROMPT_FLOORS.queries / 12_000, '여유를 못 쓰고 있다');
  assert.ok(countQueries(only) > countQueries(withNoise), '앞 섹션이 비면 쿼리를 더 실어야 한다');
});

test('어떤 섹션도 최소 몫 아래로 굶지 않는다', () => {
  // 지식이 예산을 다 먹어도 쿼리 목록은 반드시 남아야 한다 — 빠지면 그 조회를 아예 못 한다.
  const p = buildPrompt(ctx({ knowledge: knowledge(50), qaMethods: methods(50), queries: queries(35) }));
  assert.ok(/^- q0: /m.test(p), '쿼리 목록이 통째로 밀려났다');
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN);
});

test('평범한 등록량은 아무것도 잘리지 않는다', () => {
  // 이 상한은 '긴 문서 한 건이 전부를 망가뜨리는 것'을 막기 위한 것이지 평소에 개입하면 안 된다.
  const p = buildPrompt(ctx({
    chat: new Array(MAX_CHAT_TURNS).fill({ role: 'user', text: big(MAX_CHAT_LEN) }),
    knowledge: new Array(5).fill(0).map((_, i) => ({ seq: i, title: `지식${i}`, content: big(400) })),
    qaMethods: new Array(3).fill(0).map((_, i) => ({ seq: i, title: `방법${i}`, method: big(400) })),
    queries: new Array(20).fill(0).map((_, i) => ({
      seq: i, query_name: `q${i}`, query_desc: big(200), input_desc: big(60),
      output_desc: big(60), query_sql: 'SELECT A FROM T WHERE B = :b',
    })),
    history: [{ query_name: 'q0', params: { b: 1 }, rows: wideRows(3, 4), totalRows: 3 }],
  }));
  assert.ok(!p.includes('프롬프트 길이 제한으로 생략'), '평범한 등록량에서 잘렸다');
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN + OUTSIDE_BUDGET);
});

test('LLM이 만든 거대한 query_name·params도 예산을 넘지 못한다', () => {
  // 결정 경계(llm.js sanitizeDecision)가 값을 묶지만, 프롬프트 조립은 그 경계가 우회되거나
  // 느슨해져도 스스로 유계여야 한다 — renderHistory는 최소 1줄을 반드시 실으므로
  // 줄 자체가 유계가 아니면 섹션 배분으로는 막을 수 없다 (역사적으로 이 경로가 뚫려 있었다).
  const p = buildPrompt(ctx({
    history: [
      { query_name: big(5000), params: { [big(500)]: big(30000), b: big(30000), c: { nested: big(30000) } }, error: big(30000), hint: big(30000) },
      { query_name: big(5000), params: { a: big(30000) }, rows: [{ A: 1 }], totalRows: 1 },
      { query_name: big(5000), params: { a: big(30000) }, note: '실행하지 않음 사유' },
    ],
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
});

test('섹션 최소 몫 합계가 전체 예산을 넘지 않는다', () => {
  // constants.js가 import 시점에 던지므로 여기까지 왔다면 이미 참이지만, 그 검증 자체가
  // 사라지는 것을 막는다 — 이 불변식이 깨진 채로 배포된 것이 원래 버그였다.
  const sum = Object.values(PROMPT_FLOORS).reduce((a, b) => a + b, 0);
  assert.ok(sum <= MAX_PROMPT_TOTAL_LEN, `${sum} > ${MAX_PROMPT_TOTAL_LEN}`);
});
