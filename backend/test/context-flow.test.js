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
