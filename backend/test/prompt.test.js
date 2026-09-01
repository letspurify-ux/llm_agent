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

// 컬럼 수는 드라이버 경계(oracle.js MAX_RESULT_COLS)가 묶지만, 프롬프트 조립은 그 경계가
// 우회되거나 느슨해져도 스스로 유계여야 하므로 여기서는 일부러 상한 없이 만든다.
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
  // (스텝 한 줄은 fitCols가 스텝 예산 안으로 줄이므로, 이력 예산을 넘기려면 스텝 수로 채운다)
  const history = new Array(8).fill(0).map((_, i) => ({
    query_name: `step${i}`, params: {}, rows: wideRows(20, 20), totalRows: 20,
  }));
  const p = buildPrompt(ctx({ history }));
  assert.ok(p.includes('step7'), '가장 최신 스텝이 남아야 한다');
  assert.ok(p.includes('프롬프트 길이 제한으로 생략'), '버린 사실을 모델에게 알려야 한다');
  // 시간순 표시는 유지된다
  assert.ok(p.indexOf('step6') < p.indexOf('step7') || !p.includes('step6'));
});

test('컬럼 수가 아무리 많은 행도 예산을 넘지 못한다', () => {
  // fitRows의 '최소 1행 보장'이 컬럼 단위 절단(fitCols) 없이는 그대로 구멍이 된다 —
  // 드라이버 경계(MAX_RESULT_COLS)가 우회돼도 프롬프트 조립 스스로 유계여야 한다.
  const p = buildPrompt(ctx({
    history: [{ query_name: 'wide', params: {}, rows: wideRows(20, 300), totalRows: 20 }],
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
  assert.ok(p.includes('컬럼 생략'), '컬럼을 버린 사실을 모델에게 알려야 한다');
  // 줄어든 행도 유효한 JSON이어야 한다 — 조각이면 모델이 값으로 되읽는다
  JSON.parse(p.slice(p.lastIndexOf(': [') + 2));
});

test('바인드가 수백 개인 SQL 등록도 쿼리 목록 예산을 뚫지 못한다', () => {
  // 바인드 목록은 표시용 절단 전의 SQL 원문에서 나온다 — 이 줄에서 유일하게 유계가 아니던 부분.
  const sql = `SELECT 1 FROM t WHERE ${new Array(500).fill(0).map((_, i) => `c${i} = :b${i}`).join(' AND ')}`;
  const p = buildPrompt(ctx({
    queries: [{ seq: 1, query_name: 'manybinds', query_desc: 'd', input_desc: 'i', output_desc: 'o', query_sql: sql, target_db_name: 'D' }],
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
  assert.match(p, /외 \d+개/, '바인드를 버린 사실을 모델에게 알려야 한다');
});

// 목록에 실린 줄 수(짧은 형태 포함)와, 그중 SQL·입출력 설명까지 실린 '자세한' 줄 수.
const countQueryLines = s => (s.match(/^- q\d+: /gm) || []).length;
const countDetailed = s => (s.match(/^- q\d+: .* \/ SQL: /gm) || []).length;

test('앞 섹션이 짧으면 그 여유가 쿼리 목록으로 넘어간다', () => {
  // 배분이 '섹션마다 고정'이면 지식이 비어 있어도 쿼리 목록은 최소 몫에 묶인다.
  const only = buildPrompt(ctx({ queries: queries(35) }));
  const withNoise = buildPrompt(ctx({ queries: queries(35), knowledge: knowledge(30), qaMethods: methods(30) }));
  assert.ok(countDetailed(only) > PROMPT_FLOORS.queries / 12_000, '여유를 못 쓰고 있다');
  assert.ok(countDetailed(only) > countDetailed(withNoise), '앞 섹션이 비면 쿼리를 더 자세히 실어야 한다');
});

test('예산이 모자라도 쿼리 이름은 한 건도 버리지 않는다', () => {
  // 목록에서 빠진 쿼리는 모델이 지목할 방법이 없어 그 조회를 아예 못 한다 — 지식이 빠지면
  // 답이 부실해질 뿐인 것과 손해의 크기가 다르다. 게다가 어디에도 오류가 남지 않아
  // chat_log에는 '조회 없이 지식으로만 답한 요청'으로만 보인다.
  // 그래서 자세한 줄을 버리기 '전에' 이름·용도·바인드만 남긴 짧은 줄로 줄인다.
  const p = buildPrompt(ctx({
    queries: queries(35), knowledge: knowledge(30), qaMethods: methods(30),
    history: new Array(5).fill(0).map((_, i) => ({
      query_name: `h${i}`, params: { a: 1 }, rows: wideRows(20, 30), totalRows: 100, capped: true,
    })),
  }));
  assert.equal(countQueryLines(p), 35, '등록된 쿼리 이름이 프롬프트에서 사라졌다');
  assert.ok(countDetailed(p) < 35, '이 예산에서 전부 자세히 실릴 수는 없다 (전제 확인)');
  assert.match(p, /이름·용도·바인드만 표시/, '짧은 형태로 실린 사실을 모델에게 알려야 한다');
  // 짧은 줄에도 바인드는 남는다 — 없으면 첫 실행이 반드시 '값 없음'으로 실패한다
  assert.match(p, /^- q34: .* \/ 바인드\(:a\)$/m);
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
});

test('쿼리 줄이 아무리 많아져도 섹션 합계가 예산을 넘지 않는다', () => {
  // 쿼리 목록은 '마지막에 배분받는' 섹션이라 여기서 새는 몫을 흡수해 줄 뒤 섹션이 없다 —
  // 안내 줄과 줄마다의 줄바꿈을 예산에서 빼먹으면 그대로 전체 예산 밖으로 나간다.
  // 짧은 줄로 실리는 쿼리가 많을수록 그 한 칸이 쌓이므로, 짧은 설명 다수가 최악이다.
  const short = n => new Array(n).fill(0).map((_, i) => ({
    seq: i, query_name: `q${i}`, query_desc: big(120), input_desc: big(10),
    output_desc: big(10), query_sql: 'SELECT 1 FROM t WHERE a = :a', target_db_name: 'D',
  }));
  for (const n of [35, 60, 200]) {
    const p = buildPrompt(ctx({
      knowledge: knowledge(30), qaMethods: methods(30), queries: short(n),
      history: new Array(5).fill(0).map((_, i) => ({
        query_name: `h${i}`, params: { a: big(2000) }, rows: wideRows(20, 30), totalRows: 100, capped: true,
      })),
    }));
    assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `쿼리 ${n}건에서 예산을 넘었다: ${p.length}`);
  }
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

test('두 단계의 컬럼 생략 안내가 서로를 덮어쓰지 않는다', () => {
  // 드라이버 경계(oracle.js normalizeCells)가 컬럼 수 상한으로 자르며 남긴 표시와, 프롬프트
  // 조립이 길이 제한으로 자르며 남기는 표시는 키가 같다 — 한 행에 둘이 겹치면 fromEntries가
  // 나중 것만 남겨 상류의 안내가 사라지고, 모델은 실제보다 훨씬 적은 수의 컬럼만 생략된 것으로
  // 읽는다. 두 주석이 나란히 막겠다고 적어둔 실패('없는 컬럼을 없다로 단정')가 바로 그것이다.
  const row = Object.fromEntries(new Array(30).fill(0).map((_, c) => [`COL_${c}`, big(200)]));
  row['…'] = '외 10개 컬럼 생략 (컬럼 수 상한 30개)';
  const p = buildPrompt(ctx({
    history: [{ query_name: 'q0', params: {}, rows: [row], totalRows: 1 }],
  }));
  assert.ok(p.includes('컬럼 수 상한 30개'), '드라이버 단계의 생략 안내가 사라졌다');
  assert.ok(p.includes('개 컬럼 생략 (프롬프트 길이 제한)'), '프롬프트 단계의 생략 안내가 사라졌다');
});

test('섹션 최소 몫 합계가 전체 예산을 넘지 않는다', () => {
  // constants.js가 import 시점에 던지므로 여기까지 왔다면 이미 참이지만, 그 검증 자체가
  // 사라지는 것을 막는다 — 이 불변식이 깨진 채로 배포된 것이 원래 버그였다.
  const sum = Object.values(PROMPT_FLOORS).reduce((a, b) => a + b, 0);
  assert.ok(sum <= MAX_PROMPT_TOTAL_LEN, `${sum} > ${MAX_PROMPT_TOTAL_LEN}`);
});

test('제목이 길어져도 지식·처리방법 줄이 예산을 뚫지 못한다', () => {
  // renderItems는 예산과 무관하게 최소 1건을 싣는다 — 그래서 '한 줄의 크기'가 그 섹션의 실질
  // 상한이 된다. 그 줄에서 본문(content/method)만 clip하고 제목은 원문 그대로 싣고 있었으므로,
  // 유계라는 보장은 오직 schema.sql의 VARCHAR(200)에서 왔다. 프롬프트 예산과 아무 상관 없어
  // 보이는 마이그레이션 한 줄(title을 TEXT로)이면 제목 하나가 전체 예산을 그대로 넘긴다 —
  // 그 뒤 모든 질문이 컨텍스트 초과로 끝나는데 예산 어디에도 오류가 남지 않는다.
  const p = buildPrompt(ctx({
    knowledge: [{ title: big(MAX_PROMPT_TOTAL_LEN * 2), content: '내용' }],
    qaMethods: [{ title: big(MAX_PROMPT_TOTAL_LEN * 2), method: '방법' }],
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `제목이 예산을 넘겼다: ${p.length}`);
  // 잘렸다는 사실은 모델에게도 보여야 한다 (본문 절단과 같은 규칙)
  assert.match(p, /…\(생략\)/);
});
