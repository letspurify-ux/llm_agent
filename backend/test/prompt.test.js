// 프롬프트 길이 예산 회귀 테스트 — 실행: npm test
// 이 예산은 어긋나도 티가 나지 않는다: 등록 내용이 평범한 동안에는 예산에 닿지도 않다가,
// 긴 문서나 컬럼 많은 조회가 들어온 날부터 '모든 질문이 LLM 호출 실패'가 된다.
// 실제로 두 방향 모두로 어긋나 있었다 — 섹션 상한 합계가 문서(36k)와 달랐고(44k),
// 가장 큰 페이로드인 실행 이력에는 상한이 아예 없었다.
import { test } from 'node:test';
import assert from 'node:assert';
import { buildPrompt } from '../src/llm-openai.js';
import { MAX_PROMPT_TOTAL_LEN, MAX_PROMPT_STEP_LEN, PROMPT_FLOORS, PROMPT_FRAME_RESERVE, MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_QUESTION_LEN, MAX_CELL_LEN, MAX_RESULT_COLS, MAX_ROWS, MAX_STEPS, MAX_SEARCHES, MAX_HISTORY_ROWS, MAX_EXPANDS, MAX_DOC_LEN, MAX_PROMPT_ITEM_LEN, TRUNC_MARK } from '../src/constants.js';

const big = n => 'ㄱ'.repeat(n);

const ctx = (over = {}) => ({
  question: '질문', chat: [], knowledge: [], qaMethods: [], queries: [], history: [], ...over,
  // searched를 준 ctx는 이미 검색을 한 요청이다 (agent.js가 그 둘을 함께 채운다)
  tried: over.tried ?? (over.searched?.length ?? 0) > 0,
});

// 컬럼 수는 드라이버 경계(oracle.js MAX_RESULT_COLS)가 묶지만, 프롬프트 조립은 그 경계가
// 우회되거나 느슨해져도 스스로 유계여야 하므로 여기서는 일부러 상한 없이 만든다.
const wideRows = (rows, cols) =>
  new Array(rows).fill(0).map((_, r) =>
    Object.fromEntries(new Array(cols).fill(0).map((__, c) => [`COL_${c}`, `${r}-${big(200)}`])));

const knowledge = n => new Array(n).fill(0).map((_, i) => ({ seq: i, title: `지식${i}`, content: big(5000) }));
const methods = n => new Array(n).fill(0).map((_, i) => ({ seq: i, title: `방법${i}`, method: big(5000) }));
// detail: 자세한 형태(입출력·SQL)로 올릴 대상 표시 — agent.js가 절차용·상위 적중·지목된 쿼리에 붙인다.
// 예산 테스트는 '올릴 수 있는 만큼 올린다'를 재므로 전부 표시해 둔다 (표시가 없으면 짧은 줄로만 실린다).
const queries = n => new Array(n).fill(0).map((_, i) => ({
  seq: i, query_name: `q${i}`, query_desc: big(3000), input_desc: big(3000),
  output_desc: big(3000), query_sql: `SELECT ${big(3000)} FROM t WHERE a = :a`, target_db_name: 'D', detail: true,
}));

// 대화·질문은 이 예산 밖이다(각자 다른 상한으로 이미 묶여 있다) — 그 몫만큼 여유를 둔다.
const OUTSIDE_BUDGET = MAX_CHAT_TURNS * MAX_CHAT_LEN + MAX_QUESTION_LEN;

// 마지막 이력 줄의 행 JSON. 이력 뒤에 대화·질문·지시 블록이 오므로 줄 끝까지만 잘라 읽는다.
const lastRowsJson = p => {
  const start = p.lastIndexOf(': [') + 2;
  const end = p.indexOf('\n', start);
  return p.slice(start, end < 0 ? undefined : end);
};

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
  const parsed = JSON.parse(lastRowsJson(p)); // 조각이면 여기서 던진다
  assert.ok(parsed.length >= 1 && parsed.length < 20, `행이 줄어야 한다: ${parsed.length}`);
  assert.match(p, new RegExp(`총 20건 중 처음 ${parsed.length}건만 표시`));
});

test('최신 스텝을 남기고 오래된 스텝부터 버린다', () => {
  // 꼬리부터 버리면 방금 조회한 결과가 먼저 사라져 그 스텝이 통째로 헛수고가 된다.
  // (스텝 한 줄은 fitCols가 스텝 예산 안으로 줄이므로, 이력 예산을 넘기려면 스텝 수로 채운다)
  //
  // 스텝 수를 상수로 박아두지 않는다. 이력이 받는 예산은 floor가 아니라 '다른 섹션이 쓰고 남은
  // 것'이라(llm-openai renderSections), 이 ctx처럼 다른 섹션이 비면 총 상한 가까이까지 커진다.
  // 8로 박아둔 앞선 판은 예산을 22k→40k로 올리자 그대로 다 실려버려, '버린 사실을 알리는가'를
  // 검증하던 테스트가 아무것도 넘치지 않는 테스트로 조용히 바뀌었다(실측). 한 줄이 스텝 예산을
  // 넘지 못하므로, 총 상한을 스텝 예산으로 나눈 수보다 많으면 어떤 배분에서도 반드시 넘친다.
  const steps = Math.ceil(MAX_PROMPT_TOTAL_LEN / MAX_PROMPT_STEP_LEN) + 1;
  const history = new Array(steps).fill(0).map((_, i) => ({
    query_name: `step${i}`, params: {}, rows: wideRows(20, 20), totalRows: 20,
  }));
  const p = buildPrompt(ctx({ history }));
  const last = `step${steps - 1}`, prev = `step${steps - 2}`;
  assert.ok(p.includes(last), '가장 최신 스텝이 남아야 한다');
  assert.ok(p.includes('프롬프트 길이 제한으로 생략'), '버린 사실을 모델에게 알려야 한다');
  // 시간순 표시는 유지된다
  assert.ok(p.indexOf(prev) < p.indexOf(last) || !p.includes(prev));
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
  JSON.parse(lastRowsJson(p));
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
  // 고정 틀의 몫도 합에 넣는다 — 본문만 더하면 틀의 길이만큼 정확히 넘친다.
  const sum = Object.values(PROMPT_FLOORS).reduce((a, b) => a + b, 0) + PROMPT_FRAME_RESERVE;
  assert.ok(sum <= MAX_PROMPT_TOTAL_LEN, `${sum} > ${MAX_PROMPT_TOTAL_LEN}`);
});

test('고정 틀(제목·빈 줄·지시 블록)이 자기 몫 안에 든다', () => {
  // 섹션 본문은 배분이 세지만 제목 줄·블록 사이 빈 줄·질문 제목·지시 블록은 세지 않는다 —
  // 그 몫을 미리 떼는데, 떼는 값이 실제 틀보다 작으면 꽉 찬 요청에서 그 차이만큼 넘친다.
  // 틀이 가장 긴 형태(forceAnswer 지시문)로, 본문을 전부 비워 틀만 남긴 길이를 잰다.
  const empty = { question: '', chat: [], knowledge: [], qaMethods: [], queries: [], history: [], forceAnswer: true };
  const frame = buildPrompt(empty).length - 5 * '(없음)'.length;
  // 건수 자릿수 여유(섹션 다섯 곳 × 4자리)까지 더해도 몫 안이어야 한다
  assert.ok(frame + 20 <= PROMPT_FRAME_RESERVE, `틀이 몫을 넘는다: ${frame} + 20 > ${PROMPT_FRAME_RESERVE}`);
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

test('모든 섹션이 같은 규칙으로 예산을 센다', () => {
  // 배분(renderSections)은 줄마다 개행 한 칸을 함께 빼고, 생략 안내 줄도 그 몫에서 나간다.
  // 지식·처리방법·실행 이력은 개행을 세지 않고 안내 몫도 떼지 않아, 줄 수만큼 자기 몫을 넘겨 썼다.
  // 그 초과는 배분 순서상 마지막인 쿼리 목록에서 나온다 — 버려지면 그 조회를 아예 못 하는 섹션이
  // 다른 섹션의 계산 오차를 떠안는 셈이라, 손해가 가장 큰 곳으로 정확히 흘러간다.
  // 줄 수가 많을수록 어긋남이 커지므로 짧은 줄을 아주 많이 넣어 확인한다.
  const many = n => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, content: `c${i}`, method: `m${i}` }));
  const prompt = buildPrompt({
    question: 'q', chat: [],
    knowledge: many(2000), qaMethods: many(2000),
    queries: Array.from({ length: 200 }, (_, i) => ({
      query_name: `q${i}`, query_desc: 'd'.repeat(400), input_desc: 'i', output_desc: 'o',
      query_sql: `SELECT * FROM t${i} WHERE a = :a`,
    })),
    history: Array.from({ length: 500 }, (_, i) => ({ query_name: `h${i}`, params: { a: i }, rows: [{ A: i }], totalRows: 1 })),
  });
  assert.ok(prompt.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${prompt.length}`);
  // 음성 대조 — 예산이 실제로 빡빡했는지 (위 단언이 공허하지 않음을 보장)
  assert.ok(prompt.length > MAX_PROMPT_TOTAL_LEN * 0.8, `예산을 거의 안 썼다: ${prompt.length}`);
  // 가장 중요한 섹션이 실제로 살아남았는지 — 초과분이 여기서 나오면 이 줄이 먼저 사라진다
  assert.match(prompt, /## 실행 가능한 쿼리 목록 \(\d+건\)\n- q0:/);
});

test('모든 섹션이 예산에 꽉 찬 상태에서도 전체 상한을 넘지 않는다', () => {
  // 짧은 줄로 촘촘히 채우면 각 섹션이 자기 예산에 딱 붙어, 회계가 한 칸이라도 어긋나면
  // 그대로 전체 상한을 넘는다 (여유가 40자 안팎만 남는 상태다).
  // 잡아내는 어긋남이 둘이다: 줄마다 개행 한 칸을 세지 않는 것, 그리고 생략 안내 줄의 몫을
  // 떼지 않는 것(마지막에 배분받는 쿼리 목록에는 그 초과를 흡수해 줄 뒤 섹션이 없다).
  // 넘긴 만큼이 그대로 컨텍스트 한도를 밀어내 그 요청의 남은 LLM 호출이 전부 실패한다.
  for (const len of [1, 8, 60]) {
    const items = n => Array.from({ length: n }, () => ({ title: 'T', content: 'c'.repeat(len), method: 'm'.repeat(len) }));
    const prompt = buildPrompt({
      question: 'q', chat: [],
      knowledge: items(4000), qaMethods: items(4000),
      history: Array.from({ length: 3000 }, () => ({ query_name: 'h', params: {}, rows: [{ A: 'x'.repeat(len) }], totalRows: 1 })),
      queries: Array.from({ length: 400 }, (_, i) => ({
        query_name: `q${i}`, query_desc: 'd'.repeat(len), input_desc: 'i', output_desc: 'o',
        query_sql: 'SELECT 1 FROM t WHERE a=:a',
      })),
    });
    assert.ok(prompt.length <= MAX_PROMPT_TOTAL_LEN, `줄 길이 ${len}에서 예산 초과: ${prompt.length}`);
    // 음성 대조 — 안내가 실제로 붙는 상황이어야 이 단언이 뜻을 갖는다
    assert.match(prompt, /생략\)/, `줄 길이 ${len}: 생략 안내가 붙는 상황이어야 한다`);
  }
});

test('잘린 셀은 프롬프트를 지나도 앞부분이 달라지지 않는다', () => {
  // 잘린 셀에는 TRUNC_MARK가 붙어 셀 상한보다 딱 그만큼 길다. 표시 상한을 셀 상한으로 잡으면
  // '잘린 셀'만 여기서 한 번 더 잘려, 모델이 보는 앞부분이 실제로 자른 앞부분과 달라진다.
  // 그러면 그 앞부분을 옮겨 적은 바인드 값을 실행 경계(oracle.js bindProblem)가 대조할 수 없고,
  // 잘린 조각으로 조회해 0건을 얻은 뒤 그것을 '없다'로 단정하는 오답이 오류 없이 나간다.
  // 절단 경계가 서로게이트 쌍을 가른 셀(앞부분이 한 칸 짧다)에서만 드러나므로 그 형태로 확인한다.
  const cell = 'a'.repeat(MAX_CELL_LEN - 1) + TRUNC_MARK;
  // 한 행이 스텝 예산을 넘도록 컬럼을 채운다 — 그래야 컬럼 단위 절단(fitCols)이 돈다
  const wide = Object.fromEntries(Array.from({ length: MAX_RESULT_COLS }, (_, i) => [`C${i}`, cell]));
  const prompt = buildPrompt({
    question: 'q', chat: [], knowledge: [], qaMethods: [], queries: [],
    history: [{ query_name: 'q', params: {}, rows: [wide], totalRows: 1 }],
  });
  assert.match(prompt, /컬럼 생략/, '컬럼 단위 절단이 도는 상황이어야 한다');
  assert.ok(prompt.includes(cell), '잘린 셀이 원형 그대로 실려야 한다');
  assert.ok(!prompt.includes('…' + TRUNC_MARK), '표시가 겹쳐 붙으면 앞부분이 달라진 것이다');
});

// ===== 구조 — 모델이 읽는 형태 =====
// 예산과 달리 이쪽은 '틀리면 티가 나는' 종류가 아니다. 항목 경계가 무너지거나 질문이 자료 뒤에
// 파묻혀도 오류는 없고, 답의 품질만 조용히 떨어진다. 그래서 형태 자체를 고정해 둔다.

test('본문에 든 개행이 목록 항목의 경계를 무너뜨리지 않는다', () => {
  // '- [제목] 첫 줄' 다음 줄이 열(0)부터 시작하면 그 줄은 어느 항목에도 속하지 않는 문단이 되어,
  // 지식 두 건이 어디서 갈리는지 모델이 알 수 없다. SQL은 더 나쁘다 — 여러 줄짜리 SQL이 목록
  // 밖으로 흘러나오면 다음 '- 이름:' 줄이 SQL의 일부처럼 읽힌다.
  const p = buildPrompt(ctx({
    knowledge: [{ title: '재시작\n절차', content: '1) 콘솔 접속\r\n2) 작업 선택\n\n3) 재시작' }, { title: 'B', content: 'b' }],
    qaMethods: [{ title: 'M', method: '1단계\n2단계' }],
    queries: [{ query_name: 'q0', query_desc: '용도\n두 줄', input_desc: 'i', output_desc: 'o',
      query_sql: 'SELECT A\n  FROM T\n WHERE B = :b', target_db_name: 'D', detail: true }],
    history: [{ query_name: 'q0', params: { b: 1 }, error: 'ORA-00942: table or view does not exist\nHelp: https://docs.oracle.com/error-help/db/ora-00942/', hint: '다른 쿼리를\n선택하라' }],
    chat: [{ role: 'assistant', text: '### 결과\n\n| A |\n|---|\n| 1 |' }],
  }));
  // 줄 구조가 근거인 본문(지식·처리방법·대화)은 이어지는 줄을 들여 같은 항목의 연속 줄로 싣는다
  assert.ok(p.includes('- [재시작 절차] 1) 콘솔 접속\n  2) 작업 선택\n\n  3) 재시작\n- [B] b'), '지식 본문의 줄이 항목 밖으로 나갔다');
  assert.ok(p.includes('- [M] 1단계\n  2단계'));
  assert.ok(p.includes('- 에이전트: ### 결과\n\n  | A |\n  |---|\n  | 1 |'), '대화 턴의 표가 항목 밖으로 나갔다');
  // 줄바꿈이 뜻을 갖지 않는 것(SQL·설명·오류·대응)은 한 줄로 접는다 — 쿼리 한 건은 반드시 한 줄이다
  assert.match(p, /^- q0: 용도 두 줄 \/ .* \/ SQL: SELECT A FROM T WHERE B = :b$/m, '쿼리 줄이 여러 줄로 갈라졌다');
  assert.match(p, /^1\. q0 params=\{"b":1\} → 오류: ORA-00942: table or view does not exist Help: \S+ \/ 대응: 다른 쿼리를 선택하라$/m);
  // 열(0)에서 시작하는 줄은 제목·항목·안내·질문·지시뿐이어야 한다
  const stray = p.split('\n').filter(l => l && !/^(## |- |\d+\. |\(|  |현재 시각: |위 자료를)/.test(l));
  assert.deepStrictEqual(stray, ['질문'], `항목 밖으로 나간 줄: ${JSON.stringify(stray)}`);
});

test('자료가 먼저, 질문과 지시가 맨 끝에 온다', () => {
  // 모델은 마지막에 읽은 것을 가장 강하게 붙든다. 결정할 대상은 현재 질문인데 그것이 자료 수천 자
  // 앞에 있으면 후속 질문("그럼 김철수는?")처럼 짧은 것은 그대로 파묻힌다. 또 요청마다 바뀌는
  // 것(질문·대화·시각)을 뒤로 몰아야 앞부분이 스텝마다 같은 토큰열로 남아 prefix caching이 산다.
  const p = buildPrompt(ctx({
    question: '그럼 김철수는?', chat: [{ role: 'user', text: '홍길동은?' }],
    knowledge: [{ title: 'K', content: 'k' }], qaMethods: [{ title: 'M', method: 'm' }],
    queries: [{ query_name: 'q0', query_desc: 'd', input_desc: 'i', output_desc: 'o', query_sql: 'SELECT 1 FROM t WHERE a=:a' }],
    history: [{ query_name: 'q0', params: { a: 1 }, rows: [{ A: 1 }], totalRows: 1 }],
  }));
  const order = ['## 관련 지식', '## Q&A 처리 방법', '## 실행 가능한 쿼리 목록', '## 실행 이력 (검색·쿼리)', '## 최근 대화', '## 사용자 질문 (현재)\n그럼 김철수는?', '## 지시'];
  const at = order.map(h => p.indexOf(h));
  assert.ok(at.every(i => i >= 0), `빠진 섹션: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at, '섹션 순서가 어긋났다');
  // 지시는 마지막 스텝에만 붙는 것이 아니다 — 평소에도 무엇을 하라는지 프롬프트 끝에 있어야 한다
  assert.match(p, /## 지시\n현재 시각: .+\n위 자료를 근거로 현재 질문에 대한 다음 행동 하나를 JSON으로 결정하라\.$/);
  const last = buildPrompt(ctx({ forceAnswer: true }));
  assert.match(last, /## 지시\n현재 시각: .+\n더 이상 검색하거나 쿼리를 실행할 수 없다\. .*action="answer".*$/);
  assert.ok(!last.includes('위 자료를 근거로'), '마지막 스텝에 두 지시가 함께 실렸다');
});

test('현재 시각을 KST로, 요일과 함께 싣는다', () => {
  // 모델에게는 시계가 없다. "어제", "이번 주"가 든 질문에서 기준일을 얻는 길이 today_date 조회뿐이면
  // 질문마다 LLM 왕복과 DB 조회가 한 번씩 더 들고, 모델이 그 단계를 건너뛰면 학습 시점의 연도로
  // 조용히 계산한다. 시간대는 seed.sql today_date와 같은 KST여야 한다 — UTC로 실으면
  // KST 00:00~09:00 사이에 프롬프트의 오늘과 DB의 오늘이 하루 다르다.
  const p = buildPrompt(ctx(), new Date('2026-09-02T05:05:00Z'));
  assert.match(p, /^현재 시각: 2026-09-02 \(수\) 14:05 KST$/m);
  // 자정 직후(UTC로는 전날 15:00)에도 오늘이 맞아야 한다
  const midnight = buildPrompt(ctx(), new Date('2026-09-01T15:00:00Z'));
  assert.match(midnight, /^현재 시각: 2026-09-02 \(수\) 00:00 KST$/m);
  // 시각은 지시 블록(맨 끝)에만 있다 — 앞쪽에 있으면 매 분 바뀌는 값이 prefix caching을 깬다
  assert.equal(p.indexOf('현재 시각:'), p.lastIndexOf('현재 시각:'));
  assert.ok(p.indexOf('현재 시각:') > p.indexOf('## 지시'));
});

test('실행 이력의 스텝 번호는 앞선 스텝이 생략돼도 당겨지지 않는다', () => {
  // 처리 방법의 "2단계"와 모델이 보는 번호가 같은 스텝을 가리켜야 하고, 화면 trace의 순번과도
  // 같아야 한다. 생략 안내는 빠진 번호를 말해 남은 줄이 왜 3부터 시작하는지 알려준다.
  const steps = Math.ceil(MAX_PROMPT_TOTAL_LEN / MAX_PROMPT_STEP_LEN) + 1;
  const history = new Array(steps).fill(0).map((_, i) => ({
    query_name: `step${i}`, params: {}, rows: wideRows(20, 20), totalRows: 20,
  }));
  const p = buildPrompt(ctx({ history }));
  const shown = [...p.matchAll(/^(\d+)\. step(\d+) /gm)].map(m => [Number(m[1]), Number(m[2])]);
  assert.ok(shown.length > 0 && shown.length < steps, '일부가 생략되는 상황이어야 한다 (전제 확인)');
  assert.ok(shown.every(([n, i]) => n === i + 1), `번호가 당겨졌다: ${JSON.stringify(shown.slice(0, 3))}`);
  const first = shown[0][0];
  assert.match(p, new RegExp(`^\\(1~${first - 1}번 스텝은 프롬프트 길이 제한으로 생략\\)$`, 'm'));
  // 생략이 없으면 1부터 빠짐없이
  const all = buildPrompt(ctx({ history: history.slice(0, 3) }));
  assert.deepStrictEqual([...all.matchAll(/^(\d+)\. step/gm)].map(m => m[1]), ['1', '2', '3']);
});

test('모든 섹션이 같은 형태로 건수를 달고, 찾아봤는데 비면 (없음)을 싣는다', () => {
  // 제목마다 규칙이 다르면(어떤 것엔 건수가 있고 어떤 본문은 빈 채로 끝나면) 모델은 '비어 있음'과
  // '누락됨'을 가를 수 없다. 건수는 생략 안내와 맞춰 볼 때 '몇 건 중 몇 건이 실렸는지'를 준다.
  const p = buildPrompt(ctx({ searched: ['knowledge', 'qa_method', 'query'] }));
  for (const h of ['관련 지식 (0건)', 'Q&A 처리 방법 (0건)', '실행 가능한 쿼리 목록 (0건)', '실행 이력 (검색·쿼리) (0건)', '최근 대화 (0턴)']) {
    assert.ok(p.includes(`## ${h}\n(없음)`), `${h} 형태가 다르다`);
  }
  const some = buildPrompt(ctx({ queries: queries(2), history: [{ query_name: 'q0', params: {}, rows: [], totalRows: 0 }] }));
  assert.ok(some.includes('## 실행 가능한 쿼리 목록 (2건)\n- q0:'));
  assert.ok(some.includes('## 실행 이력 (검색·쿼리) (1건)\n1. q0 '));
});

test('찾아보지 않은 자료의 섹션은 아예 싣지 않고, 그 사실을 지시에 적는다', () => {
  // '(없음)'은 '찾았는데 없다'다. 찾아보지도 않은 대상을 (없음)으로 실으면 모델은 '등록된 것이 없다'로 읽고
  // 검색 없이 일반 지식으로 답한다 — 검색을 모델의 요청에 맡긴 구조에서 가장 나쁜 실패다.
  const none = buildPrompt(ctx());
  for (const h of ['## 관련 지식', '## Q&A 처리 방법', '## 실행 가능한 쿼리 목록']) {
    assert.ok(!none.includes(h), `${h}가 찾아보지도 않았는데 실렸다`);
  }
  assert.match(none, /## 지시\n현재 시각: .+\n아직 검색한 자료가 없다\. .*\n위 자료를 근거로/);
  // 일부만 찾아봤으면 그 섹션만 — 나머지는 여전히 없다
  const part = buildPrompt(ctx({ searched: ['knowledge'] }));
  assert.ok(part.includes('## 관련 지식 (0건)\n(없음)'));
  assert.ok(!part.includes('## Q&A 처리 방법') && !part.includes('## 실행 가능한 쿼리 목록'));
  assert.ok(!part.includes('아직 검색한 자료가 없다'), '한 번이라도 찾아봤으면 안내를 붙이지 않는다');
  // 처리방법이 지목해서 들어온 쿼리(경로A)는 query를 찾아본 적 없어도 실린다 — 목록에 있으면 보인다
  const viaMethod = buildPrompt(ctx({ searched: ['qa_method'], queries: queries(1) }));
  assert.ok(viaMethod.includes('## 실행 가능한 쿼리 목록 (1건)\n- q0:'));
  // 강제 답변 스텝에는 안내를 붙이지 않는다 — 더 찾아볼 수 없는데 찾으라고 말하면 안 된다
  assert.ok(!buildPrompt(ctx({ forceAnswer: true })).includes('아직 검색한 자료가 없다'));
});

test('꽉 찬 MAX_STEPS 스텝의 실행 이력이 강제 답변 스텝에서도 전부 실린다', () => {
  // 이력의 최소 몫은 'MAX_STEPS 스텝이 각자 상한까지 차도 전부 실린다'가 근거다. 예전 몫(14k)은
  // 5 × 3k + 머리말에 못 미쳐, 이력이 MAX_STEPS건인 유일한 호출(강제 답변)에서 1번 스텝이 빠졌다 —
  // 오류 없이 답변의 근거만 사라지는 실패라 다른 섹션이 예산을 꽉 채운 상태에서 확인한다.
  const full = i => ({
    query_name: `step${i}${big(150)}`, targetDb: big(150), params: { p: big(600) },
    rows: wideRows(20, 30), totalRows: MAX_ROWS, capped: true,
  });
  const history = new Array(MAX_STEPS).fill(0).map((_, i) => full(i));
  history[2] = { ...full(2), rows: undefined, error: big(1200), hint: big(1200) }; // 오류 줄도 같은 몫 안에 든다
  const p = buildPrompt(ctx({
    knowledge: knowledge(50), qaMethods: methods(50), queries: queries(35), history, forceAnswer: true,
  }));
  for (let i = 1; i <= MAX_STEPS; i++) {
    assert.match(p, new RegExp(`^${i}\\. step${i - 1}`, 'm'), `${i}번 스텝이 빠졌다`);
  }
  assert.ok(!p.includes('스텝은 프롬프트 길이 제한으로 생략'), '이력이 생략됐다');
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
});

// ===== 검색 기록 줄 =====

test('검색 기록은 대상별 적중 수를 대상 이름과 함께 한 줄로 싣는다', () => {
  const p = buildPrompt(ctx({ searched: ['knowledge', 'query'], history: [
    { search: '배치 재시작', targets: ['knowledge', 'query'], hits: { knowledge: 2, qaMethods: null, queries: 3 } },
    { search: '배치 재시작', targets: ['knowledge'], note: '이미 같은 검색어·대상으로 검색했다' },
    { search: '재시작', targets: ['knowledge', 'qa_method', 'query'], hits: { knowledge: 0, qaMethods: null, queries: null }, failed: ['qa_method', 'query'] },
  ] }));
  assert.ok(p.includes('1. 검색 "배치 재시작" [지식·쿼리] → 지식 2건 · 쿼리 3건'), p);
  assert.ok(p.includes('2. 검색 "배치 재시작" [지식] → 실행하지 않음: 이미 같은 검색어·대상으로 검색했다'), p);
  // 검색 불가는 0건과 다른 말이다 — 시스템 프롬프트가 이 표기를 그대로 언급한다
  assert.ok(p.includes('3. 검색 "재시작" [지식·처리방법·쿼리] → 지식 0건 · 처리방법 검색 불가 · 쿼리 검색 불가'), p);
  // 찾아보지 않은 대상은 줄에 나오지 않는다
  assert.ok(!p.includes('처리방법 null'));
});

test('검색 줄도 스텝 번호를 차지한다 — 차트의 data: step N이 가리키는 번호와 같아야 한다', () => {
  const p = buildPrompt(ctx({ searched: ['query'], history: [
    { search: 'x', targets: ['query'], hits: { knowledge: null, qaMethods: null, queries: 1 } },
    { query_name: 'q0', params: {}, rows: [{ A: 1 }], totalRows: 1 },
  ] }));
  assert.ok(p.includes('1. 검색 "x"'));
  assert.ok(p.includes('2. q0 params={}'));
});

test('꽉 찬 쿼리 스텝 MAX_STEPS개에 검색 줄 MAX_SEARCHES개가 더해져도 이력이 전부 실린다', () => {
  // 루프는 쿼리 결정과 검색을 따로 세므로(agent.js runs·searches) 이력에는 둘이 함께 온다.
  // 이력 몫이 쿼리 줄만으로 계산되어 있으면 검색이 더해진 강제 답변 스텝에서 1번 스텝이 조용히 빠진다.
  const full = i => ({
    query_name: `step${i}${big(150)}`, targetDb: big(150), params: { p: big(600) },
    rows: wideRows(20, 30), totalRows: MAX_ROWS, capped: true,
  });
  const search = i => ({ search: `검색${i}${big(600)}`, targets: ['knowledge', 'qa_method', 'query'], note: big(1200) });
  const history = [];
  for (let i = 0; i < MAX_SEARCHES; i++) history.push(search(i));
  for (let i = 0; i < MAX_STEPS; i++) history.push(full(i));
  const p = buildPrompt(ctx({
    forceAnswer: true, searched: ['knowledge', 'qa_method', 'query'],
    knowledge: knowledge(30), qaMethods: methods(30), queries: queries(35), history,
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
  assert.ok(p.includes('1. 검색 "검색0'), '첫 검색 줄이 빠졌다');
  assert.ok(p.includes(`${MAX_SEARCHES + 1}. step0`), '첫 쿼리 스텝이 빠졌다');
  assert.ok(!p.includes('스텝은 프롬프트 길이 제한으로 생략'), '이력이 잘렸다');
});

test('자세한 형태는 detail 표시가 붙은 쿼리만 — 나머지는 예산이 남아도 짧은 줄이다', () => {
  // 예전에는 예산이 남는 만큼 앞에서부터 전부 올렸다. 검색이 요청 시에만 도는 구조에서는 예산이 늘 남아
  // 등록 30건 × SQL 원문이 스텝마다 실렸다 — 그 prefill이 스텝 수만큼 곱해진다.
  const list = queries(6).map((q, i) => ({ ...q, detail: i < 2 }));
  const p = buildPrompt(ctx({ queries: list }));
  assert.equal(countDetailed(p), 2);
  assert.equal(countQueryLines(p), 6, '짧은 줄이라도 이름은 전부 실린다');
  assert.match(p, /위 4건은 이름·용도·바인드만 표시했다/);
});

test('이력 줄 수 상한(MAX_HISTORY_ROWS)까지는 어떤 조합이든 전부 실린다', () => {
  // 일괄 조회 전에는 루프 반복 수가 곧 줄 수여서 이 보장이 저절로 지켜졌다. 결정 하나가 조회 여럿을
  // 만들게 되면서 줄이 반복 수보다 많아질 수 있고, 실측으로 9줄에서 1번 스텝이 빠졌다 —
  // 그 손해는 '앞선 조회가 통째로 헛수고'라 오류 없이 답변만 부실해진다.
  const full = i => ({
    query_name: `step${i}${big(150)}`, targetDb: big(150), params: { p: big(600) },
    rows: wideRows(20, 30), totalRows: MAX_ROWS, capped: true,
  });
  const searchRow = i => ({ search: `검색${i}${big(600)}`, targets: ['knowledge', 'qa_method', 'query'], note: big(1200) });
  const noteRow = i => ({ query_name: `${i}${big(150)}`, targetDb: big(150), params: { p: big(600) }, note: big(1200) });
  // 길이로 따진 최악 — 쿼리 줄을 최대한 많이, 남는 자리는 안내 줄과 검색 줄
  const notes = MAX_HISTORY_ROWS - MAX_STEPS - MAX_SEARCHES;
  const history = [
    ...Array.from({ length: MAX_SEARCHES }, (_, i) => searchRow(i)),
    ...Array.from({ length: MAX_STEPS }, (_, i) => full(i)),
    ...Array.from({ length: notes }, (_, i) => noteRow(i)),
  ];
  assert.equal(history.length, MAX_HISTORY_ROWS);
  const p = buildPrompt(ctx({
    forceAnswer: true, searched: ['knowledge', 'qa_method', 'query'],
    knowledge: knowledge(30), qaMethods: methods(30), queries: queries(35), history,
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
  assert.ok(!p.includes('스텝은 프롬프트 길이 제한으로 생략'), '이력이 잘렸다 — 이력 몫이 줄 수 상한을 감당하지 못한다');
  assert.ok(p.includes('1. 검색 "검색0'), '첫 검색 줄이 빠졌다');
  assert.ok(p.includes(`${MAX_SEARCHES + 1}. step0`), '첫 쿼리 스텝이 빠졌다');
});

test('검색이 성립하지 않아 섹션이 비어도 "아직 검색한 자료가 없다"고 말하지 않는다', () => {
  // 임베딩 서버가 죽어 세 검색이 모두 불가였던 요청이다. 섹션은 없지만(그 대상들은 찾아본 것이 아니다)
  // 모델은 이미 검색을 썼다 — 여기서 '먼저 찾으라'고 다시 말하면 남은 검색 기회를 그대로 태운다.
  const p = buildPrompt(ctx({
    tried: true, searched: [],
    history: [{ search: 'x', targets: ['knowledge', 'qa_method', 'query'], hits: {}, failed: ['knowledge', 'qa_method', 'query'] }],
  }));
  assert.ok(!p.includes('아직 검색한 자료가 없다'), '검색을 이미 한 요청에 안내가 붙었다');
  assert.ok(!p.includes('## 관련 지식'), '성립하지 않은 검색의 섹션이 (없음)으로 실렸다');
  assert.match(p, /검색 불가/, '검색 불가는 이력 줄이 말해야 한다');
});

// ===== 자료 항목의 번호·펼침·버리기 =====

test('번호는 잘렸고 아직 펼치지 않은 항목에만 붙는다', () => {
  // 청구할 수 있는 자리에만 번호가 보여야 모델이 펼칠 수 없는 것을 청구하느라 스텝을 버리지 않는다.
  const p = buildPrompt(ctx({ searched: ['knowledge'], knowledge: [
    { seq: 12, title: '긴 것', content: big(MAX_PROMPT_ITEM_LEN + 1) },
    { seq: 3, title: '짧은 것', content: '본문' },
    { seq: 9, title: '이미 펼친 것', content: big(MAX_PROMPT_ITEM_LEN + 1), expanded: true },
  ] }));
  assert.match(p, /^- k12 \[긴 것\] /m, '잘린 항목에 번호가 없다');
  assert.match(p, /^- \[짧은 것\] 본문$/m, '잘리지 않은 항목에 번호가 붙었다');
  assert.match(p, /^- \[이미 펼친 것\] /m, '펼친 항목에 번호가 남았다 — 더 받을 것이 없다는 표시가 사라진다');
});

test('펼친 항목은 더 긴 상한으로 실린다', () => {
  const body = big(MAX_DOC_LEN + 500);
  const one = buildPrompt(ctx({ searched: ['knowledge'], knowledge: [{ seq: 1, title: 'K', content: body }] }));
  const two = buildPrompt(ctx({ searched: ['knowledge'], knowledge: [{ seq: 1, title: 'K', content: body, expanded: true }] }));
  const len = md => md.split('\n').find(l => l.startsWith('- ') || l.startsWith('- k')).length;
  assert.ok(len(two) > len(one) + 2000, `펼친 본문이 길어지지 않았다: ${len(one)} → ${len(two)}`);
  assert.ok(len(two) < MAX_DOC_LEN + 300, '펼친 본문이 상한을 넘었다');
});

test('버린 항목은 실리지도 세지도 않고, 버린 수는 따로 밝힌다', () => {
  // 건수만 줄여 보이면 모델은 자기가 버린 것을 길이 제한으로 잘린 것으로 읽는다.
  const p = buildPrompt(ctx({ searched: ['knowledge', 'qa_method'], knowledge: [
    { seq: 1, title: '남길 것', content: 'a' },
    { seq: 2, title: '버린 것', content: 'b', dropped: true },
    { seq: 3, title: '또 버린 것', content: 'c', dropped: true },
  ], qaMethods: [{ seq: 1, title: 'M', method: 'm' }] }));
  assert.match(p, /^## 관련 지식 \(1건, 버림 2건\)$/m);
  assert.ok(!p.includes('버린 것]'), '버린 항목이 실렸다');
  assert.match(p, /^## Q&A 처리 방법 \(1건\)$/m, '버린 것이 없으면 그 표기를 붙이지 않는다');
});

test('모두 버린 섹션은 (없음)으로 남는다 — 찾아본 사실은 사라지지 않는다', () => {
  const p = buildPrompt(ctx({ searched: ['knowledge'], knowledge: [{ seq: 1, title: 'K', content: 'a', dropped: true }] }));
  assert.match(p, /^## 관련 지식 \(0건, 버림 1건\)\n\(없음\)$/m);
});

test('펼친 항목이 상한만큼 있어도 프롬프트가 예산을 넘지 않고, 그 본문이 잘리지 않는다', () => {
  // 펼친 항목은 목록 맨 앞에 온다(agent.js) — 예산이 뒤에서부터 버리므로 그 자리라야 살아남는다.
  const expanded = Array.from({ length: MAX_EXPANDS }, (_, i) => ({
    seq: 100 + i, title: `펼친${i}`, content: big(MAX_DOC_LEN), expanded: true,
  }));
  const p = buildPrompt(ctx({
    forceAnswer: true, searched: ['knowledge', 'qa_method', 'query'],
    knowledge: [...expanded, ...knowledge(30)], qaMethods: methods(30), queries: queries(35),
    history: new Array(MAX_STEPS).fill(0).map((_, i) => ({
      query_name: `step${i}`, params: {}, rows: wideRows(20, 30), totalRows: MAX_ROWS, capped: true,
    })),
  }));
  assert.ok(p.length <= MAX_PROMPT_TOTAL_LEN, `프롬프트가 예산을 넘었다: ${p.length}`);
  for (let i = 0; i < MAX_EXPANDS; i++) {
    const line = p.split('\n').find(l => l.startsWith(`- [펼친${i}]`));
    assert.ok(line, `펼친 항목 ${i}이 실리지 않았다`);
    assert.ok(!line.includes(TRUNC_MARK), `펼친 항목 ${i}의 본문이 다시 잘렸다`);
  }
});

// ===== 청크 항목의 표기 =====
// 청크는 프롬프트 항목 상한 안이라 잘리지 않는다(chunk.js CHUNK_MAX_LEN = MAX_PROMPT_ITEM_LEN).
// 그래서 번호를 '잘렸는가'로 붙이던 옛 규칙을 그대로 두면 긴 문서에도 번호가 한 번도 안 붙고,
// 본문 청구 경로가 통째로 죽는다 — 오류 없이 답변만 부실해지는 형태다.
test('청크 항목은 잘리지 않아도 더 받을 것이 남았으면 번호가 붙는다', () => {
  const chunk = (o) => ({ seq: 12, doc_seq: 7, title: '운영 가이드', range: ' (3~7/22)', content: '가'.repeat(900), chunk_of: 22, from: 3, to: 7, ...o });
  const at = ctx => buildPrompt(ctx).split('\n').find(l => l.startsWith('- '));

  const base = { knowledge: [chunk()], qaMethods: [], queries: [], history: [], chat: [], question: 'q', searched: ['knowledge'], tried: true };
  assert.match(at(base), /^- k12 \[운영 가이드 \(3~7\/22\)\]/, '범위 밖 청크가 남았으면 번호가 보여야 한다');

  const whole = { ...base, knowledge: [chunk({ from: 1, to: 22 })] };
  assert.match(at(whole), /^- \[운영 가이드/, '문서 전체가 실렸으면 번호를 떼어 더 받을 것이 없음을 알린다');

  const capped = { ...base, knowledge: [chunk({ content: '가'.repeat(MAX_DOC_LEN) })] };
  assert.match(at(capped), /^- \[운영 가이드/, '글자 상한에 닿았으면 청구해도 늘지 않으므로 번호를 떼야 한다');

  // 범위 밖 청크가 남았고 상한에도 안 닿았지만 이웃 조각이 상한에 들어가지 않는 항목(chunk.js buildItems의 full) —
  // 앞의 둘만 보던 동안 이 항목에 번호가 남아, 청구가 한 글자도 늘리지 못했다(실측).
  const full = { ...base, knowledge: [chunk({ full: true })] };
  assert.match(at(full), /^- \[운영 가이드/, '이웃 조각이 상한에 안 들어가면 청구해도 늘지 않으므로 번호를 떼야 한다');

  // 상한은 프롬프트에 실리는 형태(들여쓰기 포함)로 잰다 — 원문 2,399자·1,200줄은 프롬프트에서 4,797자다.
  const tall = { ...base, knowledge: [chunk({ content: Array(1200).fill('a').join('\n') })] };
  assert.match(at(tall), /^- \[운영 가이드/, '줄이 많은 본문은 원문이 짧아도 프롬프트 형태로는 상한에 닿는다');
});

test('청크 항목은 문서당 상한까지 잘리지 않고 통째로 실린다', () => {
  const body = '가'.repeat(MAX_DOC_LEN);
  const p = buildPrompt({
    knowledge: [{ seq: 1, doc_seq: 1, title: '긴 지식', content: body, chunk_of: 5, from: 1, to: 5 }],
    qaMethods: [], queries: [], history: [], chat: [], question: 'q', searched: ['knowledge'], tried: true,
  });
  assert.ok(p.includes(body), '문서당 상한 안의 본문이 프롬프트에서 다시 잘리면 안 된다');
  assert.ok(!p.includes(TRUNC_MARK), '청크는 잘림 표시가 붙지 않는다');
});
