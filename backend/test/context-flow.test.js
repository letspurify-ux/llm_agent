import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitContent, buildItems, planRanges, canGrow } from '../src/chunk.js';
import { knowledgeView } from '../src/context-items.js';
import { handleQuestion, mergeFront } from '../src/agent.js';
import { buildPrompt } from '../src/llm-openai.js';
import { sanitizeDecision } from '../src/llm.js';
import { normalizeResultRead, readStoredResult } from '../src/read-result.js';
import { MAX_DOC_LEN, MAX_PROMPT_TOTAL_LEN, MAX_RESULT_ROWS, MAX_RESULT_READS, indentLines } from '../src/constants.js';

const ctx = over => ({ question: '비교', knowledge: [], qaMethods: [], queries: [], history: [], chat: [], ...over });
const source = (doc = 1) => {
  const texts = splitContent(Array.from({ length: 120 }, (_, i) => `문단 ${i}: ${String(i).padStart(3, '0').repeat(190)}.\n\n`).join(''));
  return texts.map((content, i) => ({ seq: doc * 1000 + i + 1, doc_seq: doc, chunk_no: i + 1, chunk_of: texts.length, title: `문서${doc}`, content }));
};
const window = (rows, from, to = from) => buildItems([
  { doc_seq: rows[0].doc_seq, rep: from, from, to, chunk_of: rows.length, dist: .3 },
], rows)[0];

test('재검색의 판본이 달라지면 기존 ID와 근거를 지키고 새 절은 따로 보관한다', () => {
  const original = [1, 2, 3].map(n => ({ seq: n, doc_seq: 1, chunk_no: n, chunk_of: 3,
    title: '절차', doc_hash: 'old', content: `기존 절차 ${n}` }));
  const current = original.map(c => ({ ...c, doc_hash: 'new', content: `개정 절차 ${c.chunk_no}` }));
  const first = window(original, 1, 2);
  const before = structuredClone(first);
  const list = [first];
  mergeFront(list, [window(current, 2, 3)]);
  assert.deepEqual(list.find(item => item.seq === before.seq), before);
  assert.ok(list.some(item => item.from === 3 && item.to === 3 && item.content === '개정 절차 3'));
  assert.ok(knowledgeView(list).every(item => new Set(item.chunks.map(c => c.doc_hash)).size === 1));
});

test('적중 청크의 글자가 같아도 문서 해시가 바뀐 판본으로 확대하지 않는다', async () => {
  const original = [1, 2, 3].map(n => ({ seq: n, doc_seq: 1, chunk_no: n, chunk_of: 3,
    title: '절차', doc_hash: 'old', content: `기존 절차 ${n}` }));
  const current = original.map(c => ({ ...c, doc_hash: 'new',
    content: c.chunk_no === 2 ? c.content : `개정 절차 ${c.chunk_no}` }));
  const first = window(original, 2);
  let turn = 0;
  let snapshot;
  const result = await handleQuestion('절차', [], { deps: {
    search: async () => ({ knowledge: [first] }),
    loadChunks: async () => current,
    decide: async c => {
      if (turn++ === 0) return { action: 'search', text: '절차', targets: ['knowledge'] };
      if (turn === 2) return { action: 'expand', ids: ['k2'] };
      snapshot = structuredClone(c.knowledge);
      return { action: 'answer', answer: '확보한 근거로 답변' };
    },
  } });
  assert.equal(snapshot[0].content, '기존 절차 2');
  assert.match(result.trace.find(h => h.expand)?.note ?? '', /변경/);
});

test('검색된 두 절을 중간 본문 없이 함께 표시한다', () => {
  const rows = source();
  const hits = [rows[2], rows[44]].map((r, i) => ({ ...r, _dist: .3 + i / 100 }));
  const items = buildItems(planRanges(hits), rows);
  const prompt = buildPrompt(ctx({ knowledge: items }));
  assert.equal(items.length, 2);
  assert.ok(prompt.includes(indentLines(rows[2].content)));
  assert.ok(prompt.includes(indentLines(rows[44].content)));
  assert.ok(!prompt.includes(rows[20].content));
});

test('재검색의 겹치는 구간은 ID를 유지해 합치고 떨어진 절도 보존한다', () => {
  const rows = source();
  const list = [window(rows, 3, 5)];
  const id = list[0].seq;
  mergeFront(list, [window(rows, 5, 7), window(rows, 45, 46)]);
  assert.equal(list.length, 2);
  const merged = list.find(r => r.seq === id);
  assert.equal(merged.from, 3);
  assert.equal(merged.to, 7);
  assert.ok(merged.content.includes(rows[2].content));
  assert.equal(new Set(list.flatMap(r => r.chunks.map(c => c.seq))).size, 7);
});

test('병합이 문서 표시 상한을 넘겨도 보관한 청크를 잃지 않는다', () => {
  const rows = source();
  const a = window(rows, 3, 15), b = window(rows, 12, 25);
  const list = [a];
  const expected = new Set([...a.chunks, ...b.chunks].map(c => c.seq));
  mergeFront(list, [b]);
  assert.deepEqual(new Set(list.flatMap(r => r.chunks.map(c => c.seq))), expected);
  const view = knowledgeView(list).filter(r => !r.viewOmitted);
  assert.ok(view.reduce((n, r) => n + indentLines(r.content).length, 0) <= MAX_DOC_LEN);
  const visible = view.flatMap(r => r.chunks.map(c => c.seq));
  assert.equal(new Set(visible).size, visible.length);
});

// 검색은 계획된 범위의 앞뒤 한 조각을 함께 읽어 '이웃이 문서당 상한에 들어가지 않는다'(full)를 확정한다(search.js).
// 같은 구간이 다음 검색에 다시 적중하면 병합(absorbKnowledge)이 그 판정을 지운 채 두 구간의 청크만으로 다시 세웠고 —
// 이웃을 모르니 false — '(확대 가능)'이 되살아났다. 그 표시를 따라 청구한 모델은 한 글자도 늘지 않은 채
// '더 넓힐 수 없다' 안내와 헛돈 스텝을 받았다(실측). 한쪽이 full이면 합친 구간도 full이다(합친 구간이 그쪽을 품는다).
test('같은 구간을 다시 검색해도 검색이 확정한 full 판정과 확대 표시 없음은 유지된다', async () => {
  const rows = source();
  // 한 절(10~25번)이 통째로 적중 → 계획 범위가 상한(MAX_DOC_LEN)에 닿아 full이 선다
  const hitSpan = (from, to) => {
    const hits = rows.slice(from - 1, to).map((r, i) => ({ ...r, _dist: .3 + i / 1000 }));
    const plans = planRanges(hits);
    const loaded = rows.filter(r => plans.some(p => r.chunk_no >= p.from - 1 && r.chunk_no <= p.to + 1));
    return buildItems(plans, loaded, { maxDocLen: MAX_DOC_LEN });
  };
  const [first] = hitSpan(10, 25);
  assert.equal(first.full, true, '전제: 검색이 이웃을 읽어 full을 확정했다');
  assert.equal(canGrow(first), false);

  // 단위: 같은 구간·부분 구간의 재검색은 판정을 지우지 않는다
  const list = [first];
  mergeFront(list, hitSpan(10, 25));
  assert.equal(list.length, 1);
  assert.equal(list[0].full, true, '같은 구간의 재검색이 full을 지웠다');
  assert.equal(list[0].rep, first.rep, '대표 청크가 바뀌었다');
  mergeFront(list, hitSpan(14, 18));
  assert.equal(list[0].full, true, '부분 구간의 재검색이 full을 지웠다');
  assert.equal(canGrow(list[0]), false);

  // 끝에서 끝까지: 두 번째 검색 뒤의 프롬프트에 그 항목의 '(확대 가능)'이 되살아나지 않는다
  const other = { seq: 9001, doc_seq: 2, chunk_no: 1, chunk_of: 1, rep: 1, from: 1, to: 1, full: true, title: '문서2', content: '다른 문서',
    chunks: [{ seq: 9001, doc_seq: 2, chunk_no: 1, chunk_of: 1, content: '다른 문서' }], _dist: .4 };
  let turn = 0;
  const result = await handleQuestion('절차', [], { deps: {
    loadChunks: async () => assert.fail('확대 표시가 없으면 청구도 없다 — DB를 읽을 일이 없다'),
    search: async text => ({ knowledge: [...hitSpan(10, 25), ...(text === 'b' ? [other] : [])] }),
    decide: async c => {
      if (c.forceAnswer) assert.fail('헛돈 스텝 없이 답해야 한다');
      const prompt = buildPrompt(c);
      const k = c.knowledge.find(r => r.doc_seq === 1);
      const line = prompt.split('\n').find(l => l.startsWith(`- k${k?.seq} [`));
      switch (turn++) {
        case 0: return { action: 'search', text: 'a', targets: ['knowledge'] };
        case 1:
          assert.equal(k.full, true);
          assert.doesNotMatch(line, /\(확대 가능\)/);
          return { action: 'search', text: 'b', targets: ['knowledge'] };
        default:
          assert.equal(k.full, true, '재검색이 full을 지웠다');
          assert.doesNotMatch(line, /\(확대 가능\)/, `재검색 뒤 확대 표시가 되살아났다:\n${line}`);
          return { action: 'answer', answer: '확대 표시 없음 → 바로 답' };
      }
    },
  } });
  assert.equal(result.answer, '확대 표시 없음 → 바로 답');
  assert.equal(result.trace.length, 2);
});

test('겹치는 두 검색이 합쳐져 문서 상한에 닿으면 확대 표시가 남지 않는다', async () => {
  // 검색은 계획 범위의 앞뒤 한 조각을 함께 읽어 '더 받을 것이 있는가'(full)를 그 자리에서 확정한다(search.js).
  // 그런데 겹치는 두 구간을 합칠 때는 두 구간의 청크만 손에 들고 다시 세우므로, 그 이웃을 잃으면 판정을
  // 되세울 근거가 없어 full이 false로 되돌아간다. 합친 구간은 양쪽보다 넓어 이웃이 들어갈 여지가 더 작은데도
  // '(확대 가능)'이 되살아나고, 모델이 그 번호로 청구하면 한 글자도 늘지 않은 채 청구 기회 하나(둘 중 하나)와
  // 왕복 하나를 버린다 — 번호가 붙은 항목만 청구하라는 안내를 그대로 따랐는데도 그렇다.
  const rows = source();
  const hitSpan = (from, to) => {
    const hits = rows.slice(from - 1, to).map((r, i) => ({ ...r, _dist: .3 + i / 1000 }));
    const plans = planRanges(hits);
    const loaded = rows.filter(r => plans.some(p => r.chunk_no >= p.from - 1 && r.chunk_no <= p.to + 1));
    return buildItems(plans, loaded, { maxDocLen: MAX_DOC_LEN })[0];
  };
  const A = hitSpan(3, 8);
  const B = hitSpan(7, 18);
  assert.equal(A.full, false, '전제: 각 구간은 그 자체로는 더 넓힐 수 있다');
  assert.equal(B.full, false);
  assert.ok(canGrow(A) && canGrow(B));

  const list = [structuredClone(A)];
  mergeFront(list, [structuredClone(B)]);
  assert.equal(list.length, 1, '겹치는 구간은 같은 ID로 합쳐진다');
  const merged = list[0];
  assert.equal(merged.seq, A.seq, '합쳐도 ID는 유지된다');
  assert.deepEqual([merged.from, merged.to], [3, 18]);
  assert.ok(indentLines(merged.content).length < MAX_DOC_LEN, '전제: 합친 본문은 상한 안이다');

  // 실제로 한 조각도 더 넣을 수 없다 — 확대(grow=true)가 범위를 넓히지 못한다
  const [grown] = buildItems(
    [{ doc_seq: 1, rep: merged.rep, from: merged.from, to: merged.to, chunk_of: rows.length, dist: .3 }],
    rows, { maxDocLen: MAX_DOC_LEN, grow: true });
  assert.deepEqual([grown.from, grown.to], [merged.from, merged.to], '전제: 이웃 조각이 상한에 들어가지 않는다');

  assert.equal(merged.full, true, '병합이 검색의 이웃 판정을 잃어 full이 되돌아갔다');
  assert.equal(canGrow(merged), false);

  // 끝에서 끝까지: 두 검색 뒤의 프롬프트에 그 항목의 확대 표시가 없고, 그래서 청구도 일어나지 않는다.
  let turn = 0;
  const result = await handleQuestion('절차', [], { deps: {
    loadChunks: async () => assert.fail('확대 표시가 없으면 청구도 없다 — 본문을 읽을 일이 없다'),
    search: async text => ({ knowledge: [structuredClone(text === 'a' ? A : B)] }),
    decide: async c => {
      if (c.forceAnswer) assert.fail('헛돈 스텝 없이 답해야 한다');
      const k = c.knowledge.find(o => o.doc_seq === 1);
      const line = buildPrompt(c).split('\n').find(l => l.startsWith(`- k${k?.seq} [`));
      switch (turn++) {
        case 0: return { action: 'search', text: 'a', targets: ['knowledge'] };
        case 1: return { action: 'search', text: 'b', targets: ['knowledge'] };
        default:
          assert.deepEqual([k.from, k.to], [3, 18], '두 검색이 한 구간으로 합쳐졌다');
          assert.doesNotMatch(line, /\(확대 가능\)/, `합친 뒤 확대 표시가 되살아났다:\n${line}`);
          return { action: 'answer', answer: '확대 표시 없음 → 바로 답' };
      }
    },
  } });
  assert.equal(result.answer, '확대 표시 없음 → 바로 답');
  assert.equal(result.trace.length, 2, '헛돈 청구 줄이 남지 않는다');
});

test('펼친 구간과 겹치는 후보도 같은 청크를 두 번 표시하지 않는다', () => {
  const rows = source();
  const view = knowledgeView([{ ...window(rows, 3, 8), expanded: true }, window(rows, 6, 10)]);
  const chunks = view.filter(r => !r.viewOmitted).flatMap(r => r.chunks.map(c => c.seq));
  assert.equal(new Set(chunks).size, chunks.length);
  assert.ok(chunks.includes(rows[9].seq));
});

test('반복 검색 순서와 겹침이 달라도 근거·ID·표시 예산을 유지한다', () => {
  const rows = source();
  const list = [];
  const expected = new Set();
  let seed = 47;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 60; i++) {
    const from = 1 + random(rows.length - 15);
    const incoming = window(rows, from, from + random(15));
    incoming.chunks.forEach(c => expected.add(c.seq));
    const oldIds = list.map(r => r.seq);
    mergeFront(list, [incoming]);
    assert.ok(oldIds.every(id => list.some(r => r.seq === id)), '이미 부여한 ID를 잃지 않는다');
    assert.equal(new Set(list.map(r => r.seq)).size, list.length, 'ID가 다른 구간과 충돌하지 않는다');
    assert.deepEqual(new Set(list.flatMap(r => r.chunks.map(c => c.seq))), expected);
    const before = JSON.stringify(list);
    const view = knowledgeView(list).filter(r => !r.viewOmitted);
    assert.equal(JSON.stringify(list), before, '표시가 보관 원본을 바꾸지 않는다');
    const visible = view.flatMap(r => r.chunks.map(c => c.seq));
    assert.equal(new Set(visible).size, visible.length);
    assert.ok(view.reduce((n, r) => n + indentLines(r.content).length, 0) <= MAX_DOC_LEN);
  }
});

test('숨긴 짧은 지식과 처리방법을 같은 ID로 복구하며 DB를 읽지 않는다', async () => {
  let turn = 0;
  const decisions = [
    { action: 'search', targets: ['knowledge', 'qa_method'], text: '처음' },
    { action: 'search', targets: ['knowledge'], text: '추가', drop: ['k1', 'm2'] },
    { action: 'expand', ids: ['k1', 'm2'] },
  ];
  const result = await handleQuestion('절차', [], { deps: {
    search: async () => ({ knowledge: [{ seq: 1, title: '지식', content: '보관된 지식' }], qaMethods: [{ seq: 2, title: '방법', method: '보관된 방법' }] }),
    loadChunks: async () => assert.fail('복구에는 DB가 필요 없다'),
    decide: async c => {
      if (turn === 2) {
        const p = buildPrompt(c);
        assert.ok(!p.includes('보관된 지식'));
        assert.match(p, /expand로 다시 표시: k1/);
      }
      if (turn < decisions.length) return decisions[turn++];
      assert.equal(c.knowledge[0].seq, 1);
      assert.equal(c.qaMethods[0].seq, 2);
      assert.ok(!c.knowledge[0].dropped && !c.qaMethods[0].dropped);
      assert.match(buildPrompt(c), /보관된 지식/);
      return { action: 'answer', answer: '복구 완료' };
    },
  } });
  assert.equal(result.answer, '복구 완료');
  assert.equal(result.search.expanded, 2);
});

test('표시에서 빠진 25행의 ID를 추가 읽어 다음 쿼리에 전달한다', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    ...Object.fromEntries(Array.from({ length: 20 }, (_, c) => [`C${c}`, 'x'.repeat(200)])),
    NEXT_JOB_ID: `J-${i + 1}`,
  }));
  const queries = [
    { seq: 1, query_name: 'jobs', query_sql: 'SELECT 1 FROM dual', target_db_name: 'OPS' },
    { seq: 2, query_name: 'detail', query_sql: 'SELECT :job_id FROM dual', target_db_name: 'OPS' },
  ];
  let turn = 0, executions = 0;
  const result = await handleQuestion('마지막 작업 상세', [], { deps: {
    search: async () => ({ queries }),
    run: async (q, params) => {
      executions++;
      if (q.query_name === 'jobs') return { rows, totalRows: 25, targetDb: 'OPS' };
      assert.equal(params.job_id, 'J-25');
      return { rows: [{ STATUS: 'DONE' }], totalRows: 1, targetDb: 'OPS' };
    },
    decide: async c => {
      switch (turn++) {
        case 0: return { action: 'search', text: '작업', targets: ['query'] };
        case 1: return { action: 'run_query', query_name: 'jobs', params: {} };
        case 2:
          assert.ok(!buildPrompt(c).includes('J-25'));
          return { action: 'read_result', step: 2, cols: ['NEXT_JOB_ID'], offset: 24, limit: 1 };
        case 3:
          assert.deepEqual(c.history[1].rows, [{ NEXT_JOB_ID: 'J-25' }]);
          assert.match(buildPrompt(c), /추가 읽기: 25행부터 1행/);
          return { action: 'run_query', query_name: 'detail', params: { job_id: c.history[1].rows[0].NEXT_JOB_ID } };
        default: return { action: 'answer', answer: '상세 확인 완료' };
      }
    },
  } });
  assert.equal(executions, 2);
  assert.equal(result.trace.length, 3);
  assert.equal(result.trace[1].rows.length, MAX_RESULT_ROWS, '로그의 원래 미리보기는 바꾸지 않는다');
  assert.equal(result.fullRows.get(result.trace[1]).length, 25);
  assert.equal(result.search.resultReads, 1);
});

test('결과 읽기는 범위·정확한 컬럼명·횟수를 검사하고 새 DB 조회를 만들지 않는다', async () => {
  const rows = [{ ID: 'A' }];
  assert.throws(() => readStoredResult(rows, { step: 1, offset: -1 }), /offset/);
  assert.throws(() => readStoredResult(rows, { step: 1, offset: 2 }), /보관된 결과/);
  assert.throws(() => readStoredResult(rows, { step: 1, cols: ['toString'] }), /없는 컬럼/);
  assert.equal(normalizeResultRead({ step: 1, limit: 100 }).limit, MAX_RESULT_ROWS);
  assert.equal(sanitizeDecision({ action: 'read_result', step: '1e2' }).invalid, true);
  let decisions = 0;
  const result = await handleQuestion('읽기', [], { deps: {
    run: async () => assert.fail('DB를 실행하면 안 된다'),
    decide: async c => {
      decisions++;
      if (c.forceAnswer) {
        assert.equal(c.resultReadsLeft, 0);
        assert.match(c.contextNote, /보관된 조회 결과가 없다/);
        assert.ok(buildPrompt(c).length < MAX_PROMPT_TOTAL_LEN);
        return { action: 'answer', answer: '결과 없음' };
      }
      return { action: 'read_result', step: 1 };
    },
  } });
  assert.equal(result.search.resultReads, MAX_RESULT_READS);
  assert.equal(decisions, MAX_RESULT_READS + 1);
});

// 실행한 쿼리는 뒤 검색이 후보를 얹어도 목록 앞에 남아 SQL과 함께 보여야 한다(context.md 3 — 선택된 쿼리의 상세를 먼저 배정).
// 검색 결과가 목록 맨 앞에 오는 규칙만 있던 동안, 입력 설명이 긴 등록(한 줄 1,300자 남짓)에서는 뒤 검색 한 번이 후보 30건을
// 그 앞에 쌓아 실행한 쿼리가 섹션 천장에 걸려 이름조차 사라졌다(퍼저로 잡았다 — 43건 중 20번째). 모델은 방금 실행한 쿼리를
// '목록에 없는 이름'으로 읽어 같은 쿼리를 다른 값으로 다시 실행하는 절차나 오류 뒤 바인드 수정에 근거를 잃는다.
test('실행한 쿼리는 뒤 검색이 긴 후보 30건을 얹어도 목록에 SQL과 함께 남는다', async () => {
  const registry = n => Array.from({ length: n }, (_, i) => ({
    seq: 100 + i, query_name: `candidate_${i}`, query_desc: '용도 '.repeat(40), input_desc: 'x'.repeat(1000),
    output_desc: '출력', query_sql: 'SELECT 1 FROM dual WHERE a = :a', target_db_name: 'OPS',
  }));
  const ran = { seq: 1, query_name: 'first_step', query_desc: '1단계', input_desc: 'job_id: 작업 ID', output_desc: '상태',
    query_sql: 'SELECT status FROM jobs WHERE id = :job_id', target_db_name: 'OPS' };
  let turn = 0;
  const result = await handleQuestion('절차', [], { deps: {
    search: async text => ({ queries: text === 'a' ? [ran] : registry(30) }),
    run: async () => ({ rows: [{ STATUS: 'OK' }], totalRows: 1, targetDb: 'OPS' }),
    decide: async c => {
      const lineOf = name => buildPrompt(c).split('\n').find(l => l.startsWith(`- ${name}:`));
      switch (turn++) {
        case 0: return { action: 'search', text: 'a', targets: ['query'] };
        case 1: return { action: 'run_query', query_name: 'first_step', params: { job_id: 'J1' } };
        case 2:
          assert.match(lineOf('first_step'), / \/ SQL: /, '실행 직후에는 SQL과 함께 보인다');
          return { action: 'search', text: 'b', targets: ['query'] };
        default: {
          assert.equal(c.queries.length, 31);
          assert.equal(c.queries[0].query_name, 'first_step', '실행한 쿼리가 뒤 검색의 후보에 밀렸다');
          const line = lineOf('first_step');
          assert.ok(line, `실행한 쿼리가 프롬프트에서 사라졌다:\n${buildPrompt(c).split('## 실행 가능한 쿼리 목록')[1]?.slice(0, 300)}`);
          assert.match(line, / \/ SQL: /);
          return { action: 'answer', answer: '완료' };
        }
      }
    },
  } });
  assert.equal(result.answer, '완료');
});

test('짧은 쿼리에도 입력 형식과 대상 DB를 표시하고 선택 전 SQL은 생략한다', () => {
  const q = { seq: 1, query_name: 'daily', query_desc: '일별 집계', input_desc: 'day: YYYYMMDD 필수. status: A=활성, I=비활성.',
    output_desc: 'CNT', query_sql: "SELECT COUNT(*) CNT FROM jobs WHERE day=:day AND status=:status", target_db_name: 'OPS;ARCHIVE' };
  const short = buildPrompt(ctx({ queries: [q] }));
  assert.match(short, /day: YYYYMMDD 필수/);
  assert.match(short, /status: A=활성, I=비활성/);
  assert.match(short, /대상DB/);
  assert.ok(!short.includes(q.query_sql));
  const initialDetail = buildPrompt(ctx({ queries: [{ ...q, detail: true }] }));
  assert.ok(!initialDetail.includes(q.query_sql));
  const selected = buildPrompt(ctx({ queries: [{ ...q, detail: true, selected: true }] }));
  assert.ok(selected.includes(q.query_sql));
  assert.ok(initialDetail.length < selected.length);
});

test('모델 응답 재시도의 토큰 사용량도 요청 합계에 포함한다', async () => {
  const result = await handleQuestion('절차', [], { deps: {
    decide: async c => {
      c.onUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } });
      c.onUsage({ prompt_tokens: 120, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 90 } });
      return { action: 'answer', answer: '완료' };
    },
  } });
  assert.equal(result.timing.llm[0].prompt, 220);
  assert.equal(result.timing.llm[0].completion, 30);
  assert.equal(result.timing.llm[0].cached, 170);
});

test('확대가 다른 보관 구간을 삼켜도 한 항목은 한 줄이다 — 같은 ID의 줄이 둘이 되지 않는다', async () => {
  // 확대(expand)는 대표 청크에서 문서 상한까지 넓히므로 같은 문서의 다른 보관 구간을 통째로 삼킬 수 있다.
  // 그 삼켜진 구간이 뒤이어 숨김 복구로 목록 앞에 오면, 넓힌 항목에 남는 청크가 앞뒤 두 도막이 된다 —
  // 그 둘을 다 실으면 같은 번호의 줄이 프롬프트에 두 개 실려 모델이 어느 쪽을 지목하는지 적을 수 없고,
  // 섹션 머리말의 건수(항목 수)보다 본문 줄이 많아진다.
  const rows = source();
  const narrow = window(rows, 12, 13);   // 숨겼다 복구해 앞으로 오는 좁은 구간
  const seed = window(rows, 10);         // 확대하면 12~13을 가운데 두고 양쪽으로 넘어서는 구간
  const script = [
    { action: 'search', text: '앞', targets: ['knowledge'] },
    { action: 'search', text: '뒤', targets: ['knowledge'], drop: [`k${narrow.seq}`] },
    { action: 'expand', ids: [`k${seed.seq}`] },
    { action: 'expand', ids: [`k${narrow.seq}`] },
  ];
  let last;
  await handleQuestion('운영 안내', [], { deps: {
    decide: async c => { last = c; return script.shift() ?? { action: 'answer', answer: '끝' }; },
    loadChunks: async ranges => rows.filter(r => ranges.some(g => r.chunk_no >= g.from && r.chunk_no <= g.to)),
    search: async text => ({ knowledge: [structuredClone(text === '앞' ? narrow : seed)] }),
  } });

  const grown = last.knowledge.find(o => o.seq === seed.seq);
  assert.ok(grown.from < narrow.from && grown.to > narrow.to,
    `확대 구간이 좁은 구간을 가운데 두고 넘어서야 이 회귀가 성립한다: ${grown.from}~${grown.to}`);
  assert.equal(grown.chunks.length, grown.to - grown.from + 1, '표시 제한이 보관한 청크를 지우지 않는다');

  const shown = knowledgeView(last.knowledge).filter(o => !o.dropped && !o.viewOmitted);
  assert.equal(shown.filter(o => o.seq === seed.seq).length, 1, '한 항목은 한 줄이다');
  const line = shown.find(o => o.seq === seed.seq);
  assert.ok(line.from <= grown.rep && grown.rep <= line.to, '싣는 구간은 대표 청크가 든 쪽이다');
  assert.ok(line.moreStored, '싣지 못한 보관 구간이 있으면 그 사실을 알린다');

  const prompt = buildPrompt(last);
  const section = prompt.split('## 관련 지식')[1].split('\n## ')[0];
  const ids = [...section.matchAll(/^- (k\d+) \[/gm)].map(m => m[1]);
  assert.deepEqual(ids, [...new Set(ids)], `같은 ID의 줄이 둘이다: ${ids}`);
  assert.equal(ids.length, last.knowledge.filter(o => !o.dropped).length, '본문 줄 수가 머리말의 건수와 같다');
  // 청구 기회가 남아 있으면 보관 구간이 더 있다는 사실이 프롬프트에도 실린다 (다 썼으면 표시가 사라진다).
  assert.match(buildPrompt({ ...last, canExpand: true }), /\(보관 구간 더 있음\)/);

  // 싣지 못한 구간은 지워진 것이 아니다 — 같은 ID를 앞으로 가져오면 보관한 범위가 전부 실린다.
  const front = knowledgeView([grown, last.knowledge.find(o => o.seq === narrow.seq)]);
  assert.deepEqual([front[0].seq, front[0].from, front[0].to], [seed.seq, grown.from, grown.to]);
  assert.ok(front[1].viewOmitted, '앞선 항목이 다 실으면 삼켜진 구간은 보관 목록으로 물러난다');
});

test('보관 목록의 항목은 확대가 늘리지 못해도 청구하면 앞으로 와서 본문이 실린다', async t => {
  // 프롬프트는 표시 예산에 밀린 항목을 '- (보관 중, expand로 다시 표시: k12)'로 알리고, 시스템 프롬프트는
  // "보관 목록의 ID를 청구하면 저장된 본문을 다시 우선 표시한다"고 약속한다 (context.md 2절의 '보관된 항목을
  // 앞으로 가져온다'). 그런데 확대 시도가 한 글자도 늘리지 못하면 — 이웃 조각이 문서 상한에 안 들어가거나(포화),
  // 관리 DB 읽기가 실패하면(읽기 실패) — 앞으로 가져오기까지 함께 건너뛰어 본문이 끝내 실리지 않았다.
  // 그 자리에 남는 안내는 '지금 범위로 답변하라'인데, 모델은 그 범위를 한 번도 본 적이 없다.
  // 앞으로 가져오기는 DB를 읽지 않는 일이므로 늘지 않았다는 이유로 함께 버릴 것이 아니다.
  const rows = source();
  // 문서 상한에 닿은 구간을 만들고, 검색이 그 바로 뒤 조각을 읽지 못한 상태로 둔다 —
  // 이웃을 모르니 full이 서지 않아('확대 가능'이 남아) 청구가 growItem 갈래로 들어간다.
  const capped = buildItems([{ doc_seq: 1, rep: 1, from: 1, to: rows.length, chunk_of: rows.length, dist: .3 }], rows)[0];
  const item = buildItems(
    [{ doc_seq: 1, rep: 1, from: 1, to: capped.to, chunk_of: rows.length, dist: .3 }],
    rows.slice(0, capped.to)
  )[0];
  assert.equal(item.full, false, '이웃을 읽지 못한 구간은 full이 서지 않는다');
  assert.ok(canGrow(item), '확대 갈래로 들어가야 이 회귀가 성립한다');
  // 지식 섹션 예산을 앞에서 다 쓰는 채움 항목 — 뒤에 오는 item은 본문 없이 보관 ID로만 실린다.
  const filler = Array.from({ length: 50 }, (_, i) => buildItems(
    [{ doc_seq: 100 + i, rep: 1, from: 1, to: 1, chunk_of: 1, dist: .1 + i / 10000 }],
    [{ seq: 900000 + i, doc_seq: 100 + i, chunk_no: 1, chunk_of: 1, title: `채움${i}`, content: `채움 ${i} `.repeat(160) }]
  )[0]);

  const id = `k${item.seq}`;
  const bodyLine = p => p.split('\n').find(line => line.startsWith(`- ${id} `));
  const storedNote = p => p.split('\n').find(line => line.startsWith('- (보관 중')) ?? '';

  for (const mode of ['포화', '읽기 실패']) {
    await t.test(mode, async () => {
      const prompts = [];
      const script = [{ action: 'search', text: '운영', targets: ['knowledge'] }, { action: 'expand', ids: [id] }];
      const result = await handleQuestion('운영 안내', [], { deps: {
        decide: async c => { prompts.push(buildPrompt(c)); return script.shift() ?? { action: 'answer', answer: '끝' }; },
        // 포화: 전 청크를 읽어 주지만 이웃이 상한에 들어가지 않아 한 글자도 늘지 않는다.
        // 읽기 실패: 관리 DB가 응답하지 않아 판정할 근거 자체가 없다 (기존 본문은 보존한다).
        loadChunks: async ranges => {
          if (mode === '읽기 실패') throw new Error('관리 DB 일시 장애');
          return rows.filter(r => ranges.some(g => r.chunk_no >= g.from && r.chunk_no <= g.to));
        },
        search: async () => ({ knowledge: [...filler.map(f => structuredClone(f)), structuredClone(item)] }),
      } });

      assert.ok(!bodyLine(prompts[1]), '표시 예산에 밀려 본문이 실리지 않아야 이 회귀가 성립한다');
      assert.ok(storedNote(prompts[1]).includes(id), `보관 목록이 그 ID를 청구하라고 알린다: ${storedNote(prompts[1])}`);
      assert.ok(bodyLine(prompts[2]), '보관 목록의 ID를 청구하면 저장된 본문이 다시 실린다');
      assert.deepEqual(result.trace.filter(h => h.expand), [], '앞으로 가져왔으므로 헛돈 스텝이 아니다');
      const stored = prompts[2].split('## 관련 지식')[1].split('\n## ')[0];
      assert.deepEqual([...stored.matchAll(/^- (k\d+) \[/gm)].map(m => m[1]).filter(x => x === id), [id],
        '같은 ID의 줄이 둘이 되지는 않는다');
    });
  }

  // 이미 목록 맨 앞에 있어 옮길 자리가 없으면 종전대로 '늘릴 수 없다'를 알린다 — 그 항목은 이미 실려 있다.
  await t.test('맨 앞의 항목은 늘지 않으면 그 사실을 알린다', async () => {
    const script = [{ action: 'search', text: '운영', targets: ['knowledge'] }, { action: 'expand', ids: [id] }];
    const result = await handleQuestion('운영 안내', [], { deps: {
      decide: async () => script.shift() ?? { action: 'answer', answer: '끝' },
      loadChunks: async ranges => rows.filter(r => ranges.some(g => r.chunk_no >= g.from && r.chunk_no <= g.to)),
      search: async () => ({ knowledge: [structuredClone(item)] }),
    } });
    assert.match(result.trace.find(h => h.expand)?.note ?? '', /더 넓힐 수 없다/);
  });
});

test('확대가 삼킨 구간을 다시 청구해도 그 문서의 표시가 줄지 않는다', async t => {
  // 확대는 대표 청크에서 문서 상한까지 넓히므로 같은 문서의 다른 보관 구간을 통째로 삼킬 수 있다.
  // 삼켜진 구간은 ID가 그대로 남아 본문 없이 '- (보관 중, expand로 다시 표시: k12)'로 안내되는데,
  // 그 본문은 이미 삼킨 항목의 줄에 전부 실려 있다. 안내를 그대로 따라 청구하면 새로 보이는 글자는
  // 없이 문서 상한(MAX_DOC_LEN)만 나눠 쓰게 되어, 지금 보이던 본문이 그만큼 줄어든다 —
  // 청구가 보여주던 것을 도로 가져가는 셈이고, 둘뿐인 청구 기회 하나가 그렇게 사라진다.
  const rows = source();
  const inner = window(rows, 8, 10);   // 삼켜질 구간
  const seed = window(rows, 1, 2);     // 확대하면 8~10을 품는 구간
  const shownCount = ctx => knowledgeView(ctx.knowledge)
    .filter(v => !v.dropped && !v.viewOmitted)
    .reduce((n, v) => n + (v.to - v.from + 1), 0);

  const run = async failSecondRead => {
    const script = [
      { action: 'search', text: '앞', targets: ['knowledge'] },
      { action: 'search', text: '뒤', targets: ['knowledge'] },
      { action: 'expand', ids: [`k${seed.seq}`] },
      { action: 'expand', ids: [`k${inner.seq}`] },
    ];
    const seen = [];
    let reads = 0;
    const result = await handleQuestion('문서 전체', [], { deps: {
      // ctx.knowledge는 요청 내내 같은 배열이라 나중에 보면 마지막 상태다 — 스텝별 판정은 그 자리에서 굳힌다.
      decide: async c => {
        seen.push({ ctx: c, prompt: buildPrompt(c), count: shownCount(c), view: knowledgeView(c.knowledge).map(v => ({ seq: v.seq, covered: !!v.covered, omitted: !!v.viewOmitted })) });
        return script.shift() ?? { action: 'answer', answer: '끝' };
      },
      loadChunks: async ranges => {
        if (failSecondRead && ++reads > 1) throw new Error('관리 DB 일시 장애');
        return rows.filter(r => ranges.some(g => r.chunk_no >= g.from && r.chunk_no <= g.to));
      },
      search: async text => ({ knowledge: [structuredClone(text === '앞' ? inner : seed)] }),
    } });
    return { seen, result };
  };

  // 확대가 실제로 삼켰는지 먼저 확인한다 — 삼키지 않으면 이 회귀가 성립하지 않는다.
  const { seen: base } = await run(false);
  const swallowed = base[3].ctx.knowledge.find(o => o.seq === seed.seq);
  assert.ok(swallowed.from <= inner.from && swallowed.to >= inner.to,
    `확대 구간이 좁은 구간을 품어야 한다: ${swallowed.from}~${swallowed.to}`);
  assert.deepEqual(base[3].view.find(v => v.seq === inner.seq), { seq: inner.seq, covered: true, omitted: true },
    '삼켜진 구간은 본문이 실리지 않되 covered로 구분된다');
  assert.ok((base[3].prompt.split('\n').find(l => l.startsWith('- (보관 중')) ?? '').includes(`k${inner.seq}`),
    '프롬프트는 그 번호를 보관 목록으로 안내한다');

  await t.test('넓힐 것이 남았으면 삼켜진 구간도 청구할 수 있다', async () => {
    const { seen } = await run(false);
    assert.ok(seen[4].count >= seen[3].count, `표시가 줄었다: ${seen[3].count} → ${seen[4].count}`);
    const grown = seen[4].ctx.knowledge.find(o => o.seq === inner.seq);
    assert.ok(grown.to > inner.to || grown.from < inner.from, '문서 바깥쪽으로 실제로 넓혀야 진도다');
  });

  await t.test('넓힐 수 없으면 앞으로 가져오지 않고 이미 실려 있다고 알린다', async () => {
    const { seen, result } = await run(true);
    assert.equal(seen[4].count, seen[3].count, `표시가 줄었다: ${seen[3].count} → ${seen[4].count}`);
    assert.match(result.trace.find(h => h.expand)?.note ?? '', /이미 같은 문서의 다른 항목으로 실려 있다/);
    assert.equal(seen[4].ctx.knowledge[0].seq, seed.seq, '삼킨 항목이 목록 앞을 지킨다');
  });
});
