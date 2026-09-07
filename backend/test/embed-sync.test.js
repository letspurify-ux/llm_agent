import { test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import { closePool } from '../src/db.js';
import { syncEmbeddings } from '../src/embed-sync.js';

function database(t, query, transaction = {}) {
  t.mock.method(mariadb, 'createPool', () => ({
    getConnection: async () => ({
      query: async (sql, params) => {
        if (sql.includes('GET_LOCK')) return [{ l: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ l: 1 }];
        return query(sql, params);
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: async () => {},
      ...transaction,
    }),
    end: async () => {},
  }));
  const saved = process.env.EMBEDDING_URL;
  process.env.EMBEDDING_URL = 'http://test.invalid/v1';
  t.after(async () => {
    await closePool();
    if (saved === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = saved;
  });
}

test('벡터에는 최초 스캔 이후 실제 임베딩한 본문의 해시를 저장한다', async t => {
  let source = 'before', changed = false, stored;
  const inputs = [];
  database(t, async (sql, params) => {
    if (sql.startsWith('REPLACE INTO vec_qa_method')) {
      stored = { seq: params[0], embed_hash: params[1], embedding: JSON.parse(params[2]) };
      source = 'before'; // 임베딩하는 동안 관리자가 원문을 원복한다.
      return { affectedRows: 1 };
    }
    if (sql.includes('FROM vec_qa_method')) return stored ? [stored] : [];
    if (sql.includes('FROM qa_method')) {
      if (sql.includes('WHERE seq IN') && !changed) { source = 'during'; changed = true; }
      return [{ seq: 1, title: 'title', method: source, h: `hash:${source}` }];
    }
    return [];
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { input } = JSON.parse(init.body);
    inputs.push(...input);
    return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [text.endsWith('before') ? 1 : 2] })) }));
  });
  await syncEmbeddings();
  await syncEmbeddings();
  assert.deepEqual(inputs, ['title\nduring', 'title\nbefore']);
  assert.deepEqual(stored.embedding, [1], '현재 원문과 다른 벡터를 최신으로 판단하면 안 된다');
});

test('청크에는 최초 스캔 이후 실제 분할한 본문의 해시를 저장한다', async t => {
  let source = 'before', changed = false, chunk;
  database(t, async (sql, params) => {
    if (sql.includes('FROM knowledge WHERE')) {
      if (!changed) { source = 'during'; changed = true; }
      return [{ seq: 1, title: 'title', content: source, h: `hash:${source}` }];
    }
    if (/FROM knowledge\s*$/.test(sql)) return [{ seq: 1, h: `hash:${source}` }];
    if (sql.includes('GROUP BY doc_seq')) return chunk ? [{ doc_seq: 1, h: chunk.hash }] : [];
    if (sql.includes('INSERT INTO knowledge_chunk')) {
      chunk = { hash: params[3], content: params[5] };
      source = 'before';
      return { affectedRows: 1 };
    }
    if (sql.startsWith('DELETE FROM knowledge_chunk')) return { affectedRows: 0 };
    return [];
  });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('이 검사는 청크 재생성만 한다'));
  await syncEmbeddings();
  await syncEmbeddings();
  assert.equal(chunk.content, 'before', '원복된 문서인데 다른 본문 청크를 최신으로 판단하면 안 된다');
});

test('청크 커밋 실패는 롤백하고 삭제 건수를 성공으로 집계하지 않는다', async t => {
  let rolledBack = 0;
  database(t, async sql => {
    if (sql.includes('FROM knowledge WHERE')) return [{ seq: 1, title: 'title', content: 'new', h: 'new-hash' }];
    if (/FROM knowledge\s*$/.test(sql)) return [{ seq: 1, h: 'new-hash' }];
    if (sql.includes('GROUP BY doc_seq')) return [{ doc_seq: 1, h: 'old-hash' }];
    if (sql.startsWith('DELETE FROM knowledge_chunk')) return { affectedRows: 2 };
    return [];
  }, {
    commit: async () => { throw new Error('fixture commit failure'); },
    rollback: async () => { rolledBack++; },
  });
  const result = await syncEmbeddings();
  assert.equal(result.chunksDropped, 0);
  assert.equal(result.chunks, 0);
  assert.equal(result.chunksFailed, 1);
  assert.equal(rolledBack, 1);
});

// 지시문 접두(EMBEDDING_QUERY_PREFIX)는 질의에만 붙는다 — 문서는 원문 그대로 임베딩해야 한다.
// 양쪽에 다 붙이면 모델이 학습한 비대칭이 사라지고, 오류 없이 검색 품질만 조용히 떨어진다.
// 접두를 넣는 쪽(search.js embedText)의 짝이 되는 검사다 — 한쪽만 있으면 계약의 절반만 지켜진다.
test('문서 임베딩에는 질의 지시문 접두가 붙지 않는다', async t => {
  const saved = process.env.EMBEDDING_QUERY_PREFIX;
  process.env.EMBEDDING_QUERY_PREFIX = 'Instruct: 근거를 찾아라\nQuery: ';
  t.after(() => { if (saved === undefined) delete process.env.EMBEDDING_QUERY_PREFIX; else process.env.EMBEDDING_QUERY_PREFIX = saved; });
  const inputs = [];
  database(t, async sql => {
    if (sql.includes('FROM qa_method')) return [{ seq: 1, title: '점검', method: '본문', h: 'h1' }];
    return [];
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { input } = JSON.parse(init.body);
    inputs.push(...input);
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1] })) }));
  });
  await syncEmbeddings();
  assert.deepEqual(inputs, ['점검\n본문']);
});
