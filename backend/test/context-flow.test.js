import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitContent, buildItems, planRanges } from '../src/chunk.js';
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
