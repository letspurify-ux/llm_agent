// 검색 경계 회귀 테스트 — 실행: npm test
// 검색은 벡터 단일 경로다(search.js 머리말). 그래서 '검색이 성립하지 않았다'(null)와 '찾았는데 없다'([])의
// 구분이 이 파일의 유일한 계약이고, 그 구분이 무너지면 모델은 '등록된 자료가 없다'고 조용히 단정한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import mariadb from 'mariadb';
import { closePool } from '../src/db.js';
import { handleQuestion } from '../src/agent.js';
import { buildPrompt } from '../src/llm-openai.js';
import { canGrow } from '../src/chunk.js';
import { searchKnowledge, searchQaMethods, searchQueries, warmUpEmbedding, SEARCH_COLUMNS, vecTable, CHUNK_OVERFETCH } from '../src/search.js';

async function withSearchDb(context, query, run) {
  const saved = process.env.EMBEDDING_URL;
  process.env.EMBEDDING_URL = 'http://test.invalid/v1';
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: [{ index: 0, embedding: [1, 0] }],
  })));
  context.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({ query, release: async () => {} }),
    end: async () => {},
  }));
  try { await run(); } finally {
    await closePool();
    if (saved === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = saved;
  }
}

test('검색과 보충 조회 사이 문서가 바뀌면 다른 판본의 중간 청크를 섞지 않는다', async context => {
  const original = [1, 2, 3].map(n => ({ seq: n, doc_seq: 1, chunk_no: n, chunk_of: 3,
    doc_hash: 'old', title: '절차', content: `기존 근거 ${n}`, _dist: n / 10 }));
  const current = original.map(row => ({ ...row, doc_hash: 'new',
    // 적중 청크의 글자가 같아도 중간 내용이 바뀌면 다른 문서 판본이다.
    content: row.chunk_no === 2 ? '개정된 중간 절차' : row.content }));
  await withSearchDb(context, async sql => {
    if (sql.includes('vec_knowledge_chunk')) return [original[0], original[2]];
    if (sql.includes('FROM knowledge_chunk')) return current;
    assert.fail(sql);
  }, async () => {
    const items = await searchKnowledge('갱신 중인 문서의 두 근거');
    assert.deepEqual(items.flatMap(item => item.chunks.map(c => c.seq)), [1, 3]);
    assert.ok(items.every(item => !item.content.includes('개정된 중간 절차')));
  });
});

test('청크 보충 읽기가 실패해도 같은 문서의 떨어진 적중을 모두 보존한다', async context => {
  const hits = [1, 3].map((n, i) => ({
    seq: n, doc_seq: 1, chunk_no: n, chunk_of: 5, title: '절차', content: `근거 ${n}`, _dist: 0.1 + i * 0.1,
  }));
  await withSearchDb(context, async sql => {
    if (sql.includes('vec_knowledge_chunk')) return hits;
    if (sql.includes('FROM knowledge_chunk')) throw new Error('chunk read timeout');
    assert.fail(`예상 밖 SQL: ${sql}`);
  }, async () => {
    const items = await searchKnowledge('같은 문서의 두 근거');
    assert.deepEqual(items.flatMap(item => item.chunks.map(chunk => chunk.seq)), [1, 3]);
  });
});

test('처리방법 라우팅 조회가 실패해도 성공한 직접 쿼리 검색은 보존한다', async context => {
  await withSearchDb(context, async sql => {
    if (sql.includes('vec_qa_method')) return [{ seq: 1, title: '절차', method: 'direct_query 실행' }];
    if (sql.includes('vec_query_registry')) return [{ seq: 2, query_name: 'direct_query', query_sql: 'SELECT 1 FROM dual' }];
    if (sql.includes('LOCATE')) throw new Error('routing timeout');
    if (sql.includes('query_name IN')) return [];
    assert.fail(`예상 밖 SQL: ${sql}`);
  }, async () => {
    let snapshot;
    const result = await handleQuestion('라우팅 장애', [], { deps: {
      decide: async ctx => {
        if (!ctx.history.length) return { action: 'search', text: '라우팅 장애', targets: ['qa_method', 'query'] };
        snapshot = ctx;
        return { action: 'answer', answer: '답' };
      },
    } });
    assert.deepStrictEqual(snapshot.queries.map(row => row.query_name), ['direct_query']);
    assert.equal(snapshot.queries[0].detail, true);
    assert.equal(result.search.queries, 1);
    assert.equal(result.search.queriesFailed, true);
    assert.equal(result.search.searchFailed, undefined);
    assert.doesNotMatch(buildPrompt(snapshot), /쿼리 검색 불가/);
  });
});

test('청크 보충 읽기가 실패하거나 빈 결과여도 적중 본문과 청구 경로를 보존한다', async context => {
  let mode = 'throw';
  const hit = { seq: 7, doc_seq: 3, chunk_no: 2, chunk_of: 5, title: '긴 지식', content: '검색된 본문', _dist: 0.2 };
  await withSearchDb(context, async sql => {
    if (sql.includes('vec_knowledge_chunk')) return [hit];
    if (sql.includes('FROM knowledge_chunk')) {
      if (mode === 'throw') throw new Error('chunk read timeout');
      return [];
    }
    assert.fail(`예상 밖 SQL: ${sql}`);
  }, async () => {
    for (mode of ['throw', 'empty']) {
      const items = await searchKnowledge(`청크 보충 ${mode}`);
      assert.equal(items.length, 1, mode);
      assert.equal(items[0].content, hit.content);
      assert.equal(items[0].from, 2, mode);
      assert.equal(items[0].to, 2, mode);
      assert.equal(canGrow(items[0]), true, mode);
    }
  });
});

test('임베딩이 설정되지 않았으면 검색은 null(검색 불가)이고 관리 DB를 건드리지 않는다', async () => {
  // DB 풀이 없는 환경에서 돈다 — 검색이 DB를 만지면 여기서 접속 오류로 죽는다. 빈 배열을 돌려주면 안 된다:
  // 그것은 '찾았는데 없다'이고, 호출부(agent.js)는 그 둘을 다르게 기록한다.
  const saved = process.env.EMBEDDING_URL;
  delete process.env.EMBEDDING_URL;
  try {
    assert.equal(await searchKnowledge('배치 재시작'), null);
    assert.equal(await searchQaMethods('배치 재시작'), null);
    // 정확 이름 조회의 임베딩 없는 경로는 별도 테스트에서 검증한다.
    assert.equal(await warmUpEmbedding(), false, '미설정이면 예열도 하지 않는다');
  } finally {
    if (saved !== undefined) process.env.EMBEDDING_URL = saved;
  }
});

test('빈 검색어는 검색 불가가 아니라 0건이다', async () => {
  // 빈 입력을 임베딩 서버에 보내면 거부되어 '검색 불가'로 기록된다 — 정상 경로에서는 오지 않지만
  // (agent.js가 빈 검색어를 질문으로 대신한다) 이 경계는 스스로 그것을 가려야 한다.
  const saved = process.env.EMBEDDING_URL;
  process.env.EMBEDDING_URL = 'http://127.0.0.1:9';   // 닿지 않는 주소 — 빈 검색어는 여기까지 가면 안 된다
  try {
    assert.deepEqual(await searchKnowledge('   '), []);
    assert.deepEqual(await searchQueries(undefined), []);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = saved;
  }
});

test('정확한 쿼리 이름은 임베딩 없이 찾고 실행 명세를 보존한다', async context => {
  await withSearchDb(context, async (sql, params) => {
    assert.match(sql, /query_name IN/);
    assert.deepEqual(params, ['daily_count']);
    return [{ seq: 9, query_name: 'daily_count', query_sql: 'SELECT :day FROM dual', input_desc: 'day: YYYYMMDD' }];
  }, async () => {
    delete process.env.EMBEDDING_URL;
    context.mock.method(globalThis, 'fetch', async () => assert.fail('정확 일치에는 임베딩이 필요 없다'));
    const rows = await searchQueries(' daily_count ');
    assert.equal(rows[0].query_name, 'daily_count');
    assert.equal(rows[0].input_desc, 'day: YYYYMMDD');
    assert.equal(rows[0].exact, true);
  });
});

test('정확한 이름이 없으면 벡터 검색으로 이어진다', async context => {
  await withSearchDb(context, async sql => {
    if (sql.includes('query_name IN')) return [];
    assert.match(sql, /vec_query_registry/);
    return [{ seq: 4, query_name: 'semantic_match' }];
  }, async () => {
    assert.equal((await searchQueries('작업별 처리량'))[0].query_name, 'semantic_match');
  });
});

test('한 문서의 두 검색 구간이 보충 읽기 뒤에도 각각 남는다', async context => {
  const chunks = [3, 45].map((no, i) => ({ seq: 100 + no, doc_seq: 1, chunk_no: no, chunk_of: 60,
    title: '운영 규칙', content: no === 3 ? 'A 절 근거' : 'B 절 근거', _dist: .3 + i / 100 }));
  await withSearchDb(context, async sql => {
    if (sql.includes('vec_knowledge_chunk')) return chunks;
    if (sql.includes('FROM knowledge_chunk')) return chunks;
    assert.fail(sql);
  }, async () => {
    const items = await searchKnowledge('두 정책 비교');
    assert.deepEqual(items.map(r => [r.from, r.content]), [[3, 'A 절 근거'], [45, 'B 절 근거']]);
  });
});

test('임베딩 원문 컬럼은 세 소스 모두 제목/이름이 첫 컬럼이다', () => {
  // embed-sync.js가 이 정의로 원문을 만든다 — 첫 컬럼이 제목이어야 짧은 제목 매칭이 본문에 묻히지 않는다.
  // 지식은 원문(knowledge)이 아니라 청크를 검색한다 — 원문은 임베딩 상한에서 잘려 앞부분만 벡터가
  // 되므로 긴 문서의 뒷부분이 어떤 검색어로도 걸리지 않았다 (chunk.js 머리말).
  assert.deepEqual(Object.keys(SEARCH_COLUMNS), ['knowledge_chunk', 'qa_method', 'query_registry']);
  assert.equal(SEARCH_COLUMNS.knowledge_chunk[0], 'title');
  assert.equal(SEARCH_COLUMNS.qa_method[0], 'title');
  assert.equal(SEARCH_COLUMNS.query_registry[0], 'query_name');
});

// 임베딩 테이블 이름은 규칙 하나로 파생한다 — 매핑 표를 따로 들면 소스를 더할 때 한쪽만 고쳐지고,
// 그 실패는 '검색 불가'로만 보여 원인을 가리키지 않는다 (schema.sql의 vec_* 이름과 같은 규칙).
test('임베딩 테이블 이름이 소스마다 따로 파생된다', () => {
  for (const src of Object.keys(SEARCH_COLUMNS)) assert.equal(vecTable(src), `vec_${src}`);
  assert.equal(new Set(Object.keys(SEARCH_COLUMNS).map(vecTable)).size, Object.keys(SEARCH_COLUMNS).length,
    '두 소스가 같은 임베딩 테이블을 쓰면 서로의 벡터를 지운다');
});

// 지식 검색은 '청크'를 받아 '문서'로 접는다. 한 문서가 적중을 독차지하면 청크 20건이 문서 1건으로
// 접히고, 다른 문서는 후보에 오르지도 못한 채 사라진다 — 오류 없이 지식 절반이 안 보이는 상태다.
// 실측: 청크 20건을 받으면 문서 1개, 60건을 받으면 문서 9개였다.
//
// 배수를 '안쪽' 질의에 걸면 아무 일도 하지 않는다는 것도 함께 잰다: 바깥의 거리 필터는 거리 순서와
// 단조라 상위 60건을 걸러 20건을 취하나 상위 20건을 걸러 취하나 결과가 같다. 그래서 배수는
// '병합 뒤 몇 항목이 남는가'에 걸려야 하고, 그 자리는 바깥 상한이다.
test('지식 검색은 문서 상한보다 많은 청크를 받는다 — 병합이 항목 수를 줄이므로', async () => {
  assert.ok(CHUNK_OVERFETCH >= 2, '배수가 1이면 한 문서가 후보를 독차지할 때 다른 문서가 통째로 사라진다');
  const src = readFileSync(new URL('../src/search.js', import.meta.url), 'utf8');
  const fn = /export async function searchKnowledge[\s\S]*?\n}/.exec(src)[0];
  assert.match(fn, /LIMIT \* CHUNK_OVERFETCH/, '지식 검색이 배수를 적용하지 않는다');
  assert.match(fn, /\.slice\(0, LIMIT\)/, '병합한 문서를 상한까지 잘라야 한다');
  // 나머지 두 소스는 병합이 없으므로 배수를 쓰지 않는다 — 쓰면 프롬프트만 커진다.
  for (const name of ['searchQaMethods', 'searchQueries']) {
    const other = new RegExp(`export (?:async )?function ${name}[\\s\\S]*?\\n}`).exec(src)[0];
    assert.ok(!/CHUNK_OVERFETCH/.test(other), `${name}에는 배수가 필요 없다`);
  }
});

// 예열(warmUpEmbedding)은 server.js가 종료 경로에서 기다리는 backgroundJobs의 하나다. 임베딩 서버가
// 응답하지 않으면 embed()의 자체 상한은 60초인데(모델 콜드 로드가 30초+ 걸리는 것이 정상이라 그 창은
// 기동 직후 재배포와 정확히 겹친다), 종료 경로의 강제 타이머는 10초다 — 신호를 받지 않으면 정상 종료가
// 매번 강제 종료(코드 1)가 되고 그 타이머는 process.exit이라 closePool()·closeOraclePools()가 실행되지
// 않는다(실측: 10.0초/코드 1 → 신호를 준 뒤 50ms/코드 0). 같은 신호를 쓰는 embed-sync는 처음부터
// 그렇게 하고 있었으므로, 이 검사는 '형제 갈래가 같은 신호를 지나는가'를 잡는다.
test('예열은 종료 신호를 받으면 임베딩 상한(60초)까지 매달리지 않는다', async context => {
  const saved = process.env.EMBEDDING_URL;
  process.env.EMBEDDING_URL = 'http://test.invalid/v1';
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
  // 신호가 끊을 때까지 답하지 않는 임베딩 서버 (embedding.test.js의 상한 검사와 같은 대역)
  context.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
  }));
  try {
    const controller = new AbortController();
    const warming = warmUpEmbedding(controller.signal);
    controller.abort();
    const outcome = await Promise.race([
      warming.then(ok => ({ ok })),
      new Promise(resolve => setTimeout(() => resolve('매달림'), 500)),
    ]);
    assert.notEqual(outcome, '매달림', '종료 신호를 무시하고 임베딩 상한까지 기다렸다');
    assert.equal(outcome.ok, false);
    // 정상 종료로 끊은 것은 실패가 아니다 — 경고를 남기면 재배포마다 '임베딩 서버에 닿지 못했다'는
    // 오해를 부르는 줄이 쌓인다 (embed-sync.js embedStale이 쓰는 것과 같은 판정).
    assert.deepEqual(warnings.filter(w => /embedding call failed/.test(w)), []);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = saved;
  }
});

// 지시문을 학습한 임베딩 모델(Qwen3-Embedding·Harrier 계열)은 **질의에만** 한 문장 지시문을 붙이고
// 문서에는 붙이지 않는다 — 그 비대칭이 곧 모델의 학습 형식이다. 붙이지 않거나 양쪽에 다 붙이면
// 오류는 나지 않고 검색 품질만 조용히 떨어지므로, 이 계약은 검사가 유일한 방어선이다.
// 설정하지 않으면 지금까지와 글자 하나 다르지 않아야 한다 (bge-m3처럼 지시문을 안 쓰는 모델).
test('질의 지시문 접두는 질의에만 붙고, 설정하지 않으면 아무것도 붙지 않는다', async context => {
  const savedUrl = process.env.EMBEDDING_URL;
  const savedPrefix = process.env.EMBEDDING_QUERY_PREFIX;
  process.env.EMBEDDING_URL = 'http://test.invalid/v1';
  const 보낸것 = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    보낸것.push(...JSON.parse(init.body).input);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  context.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({ query: async () => [], release: async () => {} }),
    end: async () => {},
  }));
  try {
    // ① 미설정 — 원문 그대로
    delete process.env.EMBEDDING_QUERY_PREFIX;
    await searchQaMethods('배치 재시작');
    assert.deepEqual(보낸것, ['배치 재시작']);

    // ② 큰따옴표로 준 값(dotenv가 이미 줄바꿈으로 푼 형태)
    보낸것.length = 0;
    process.env.EMBEDDING_QUERY_PREFIX = 'Instruct: 사내 질문에 답할 근거를 찾아라\nQuery: ';
    await searchQaMethods('점검 일정');
    assert.deepEqual(보낸것, ['Instruct: 사내 질문에 답할 근거를 찾아라\nQuery: 점검 일정']);

    // ③ 따옴표를 잊어 백슬래시가 그대로 온 값 — dotenv는 큰따옴표일 때만 이스케이프를 푼다(실측 16.6.1).
    //    두 표기가 같은 프롬프트가 되어야 '따옴표를 잊었는지'가 검색 결과를 가르지 않는다.
    보낸것.length = 0;
    process.env.EMBEDDING_QUERY_PREFIX = 'Instruct: 사내 질문에 답할 근거를 찾아라\\nQuery: ';
    await searchQaMethods('점검 일정 2');
    assert.deepEqual(보낸것, ['Instruct: 사내 질문에 답할 근거를 찾아라\nQuery: 점검 일정 2']);

    // ④ 캐시 키는 접두를 뺀 원문이다 — 같은 검색어를 두 번 찾아도 임베딩 왕복은 한 번이다
    보낸것.length = 0;
    await searchQaMethods('점검 일정 2');
    assert.deepEqual(보낸것, [], '같은 검색어가 접두 때문에 캐시를 비켜 갔다');
  } finally {
    if (savedUrl === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = savedUrl;
    if (savedPrefix === undefined) delete process.env.EMBEDDING_QUERY_PREFIX; else process.env.EMBEDDING_QUERY_PREFIX = savedPrefix;
    await closePool();
  }
});
