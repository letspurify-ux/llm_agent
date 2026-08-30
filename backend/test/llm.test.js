// 답변 조립(renderAnswer) 회귀 테스트 — 실행: npm test
// 두 곳이 같은 함수를 쓴다: Mock provider의 답변이자, 실제 LLM이 끝내 결정을 내지 못했을 때
// agent.js가 쓰는 폴백이다. 이 폴백이 없으면 조회를 세 번 성공한 요청도 'LLM 호출 실패' 한 줄로 끝난다.
// '조립할 것이 없음'을 null로 알리는 계약이 핵심이다 — 안내 문구는 두 호출부가 서로 달라야 한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderAnswer } from '../src/llm.js';
import { MAX_ROWS, TRUNC_MARK } from '../src/constants.js';

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
    renderAnswer({ knowledge: [], history: [{ query_name: 'q', params: {}, error: 'ORA-00942' }] }),
    /실행 오류: ORA-00942/
  );
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
