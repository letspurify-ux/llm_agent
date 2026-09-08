import { test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import { vector } from './fixtures/vector.js';
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
    return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: vector(text.endsWith('before') ? 0 : 1) })) }));
  });
  await syncEmbeddings();
  await syncEmbeddings();
  assert.deepEqual(inputs, ['title\nduring', 'title\nbefore']);
  assert.deepEqual(stored.embedding, vector(), '현재 원문과 다른 벡터를 최신으로 판단하면 안 된다');
});

test('청크에는 최초 스캔 이후 실제 분할한 본문의 해시를 저장한다', async t => {
  let source = 'before', changed = false, chunk;
  database(t, async (sql, params) => {
    if (sql.includes('FROM knowledge WHERE')) {
      if (!changed) { source = 'during'; changed = true; }
      return [{ seq: 1, title: 'title', content: source, h: `hash:${source}` }];
    }
    if (/FROM knowledge\s*$/.test(sql)) return [{ seq: 1, h: `hash:${source}` }];
    if (sql.includes('GROUP BY doc_seq')) return chunk ? [{ doc_seq: 1, h: chunk.hash, max_h: chunk.hash, n: 1, first_no: 1, last_no: 1, min_of: 1, max_of: 1 }] : [];
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
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: vector() })) }));
  });
  await syncEmbeddings();
  assert.deepEqual(inputs, ['점검\n본문']);
});

test('동기화 종료 요청은 진행 중인 임베딩을 취소하고 DB 락을 반납한다', async t => {
  const isolated = await import('../src/embed-sync.js?stop-regression');
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let released = 0;
  database(t, async sql => sql.includes('FROM qa_method')
    ? [{ seq: 1, title: '종료', method: '본문', h: 'h' }] : [], {
    release: async () => { released++; },
  });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    entered();
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  const pending = isolated.syncEmbeddings();
  await started;
  const before = released;
  isolated.requestSyncStop();
  const result = await pending;
  assert.equal(result.skipped, isolated.SKIP.STOPPED);
  assert.equal(result.embedded, 0);
  assert.equal(result.failed, 0);
  assert.ok(released > before, '동기화가 쥐고 있던 커넥션을 반납한다');
});

test('벡터 저장 중 종료 요청 뒤에는 새 쓰기를 시작하지 않고 다음 실행이 남은 행을 복구한다', async t => {
  const cases = [['batch-failure', 1, 0, 0], ['row-retry', 2, 1, 0], ['row-failure', 2, 0, 1],
    ['batch-success', 1, 3, 0], ['embed-row', 3, 3, 0]];
  for (const [stage, expectedWrites, expectedStored, expectedFailed] of cases) {
    await t.test(stage, async t => {
      const isolated = await import(`../src/embed-sync.js?stop-store-${stage}`);
      const source = [1, 2, 3].map(seq => ({ seq, query_name: `q${seq}`, query_desc: '설명', h: `hash-${seq}` }));
      const stored = new Map();
      let writes = 0;
      database(t, async (sql, params) => {
        if (sql.includes('FROM vec_query_registry')) return [...stored].map(([seq, embed_hash]) => ({ seq, embed_hash }));
        if (sql.includes('FROM query_registry')) return sql.includes('WHERE seq IN')
          ? source.filter(row => params.slice(1).includes(row.seq)) : source;
        if (!sql.startsWith('REPLACE INTO vec_query_registry')) return [];
        writes++;
        if (writes === 1 && ['batch-failure', 'row-retry', 'row-failure'].includes(stage)) {
          if (stage === 'batch-failure') isolated.requestSyncStop();
          throw new Error('fixture batch failure');
        }
        if (stage === 'row-failure' && writes === 2) {
          isolated.requestSyncStop();
          throw new Error('fixture row failure');
        }
        for (let i = 0; i < params.length; i += 3) stored.set(params[i], params[i + 1]);
        if ((stage === 'row-retry' && writes === 2) || stage === 'batch-success'
          || (stage === 'embed-row' && writes === 3)) isolated.requestSyncStop();
        return { affectedRows: params.length / 3 };
      });
      t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
        const { input } = JSON.parse(body);
        if (stage === 'embed-row' && input.length > 1) return new Response('fixture input rejection', { status: 400 });
        return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: vector() })) }));
      });
      const result = await isolated.syncEmbeddings();
      assert.equal(writes, expectedWrites, '종료 신호 뒤 남은 행에 새 쓰기를 보내면 안 된다');
      assert.equal(result.embedded, expectedStored);
      assert.equal(result.failed, expectedFailed, '실패한 행만 세고 종료로 미룬 행은 실패로 집계하지 않는다');
      assert.equal(result.skipped, isolated.SKIP.STOPPED, '마지막 배치라도 종료 상태를 보존한다');
      const restarted = await import(`../src/embed-sync.js?restart-store-${stage}`);
      assert.equal((await restarted.syncEmbeddings()).embedded, 3 - expectedStored);
      assert.equal(stored.size, 3);
      assert.equal((await restarted.syncEmbeddings()).embedded, 0);
    });
  }
});

test('변경 행이 본문 읽기 전에 삭제되어도 종료 상태를 보존하고 다음 읽기를 멈춘다', async t => {
  for (const count of [1, 1001]) {
    await t.test(`${count}개 변경 행`, async t => {
      const isolated = await import(`../src/embed-sync.js?stop-empty-content-${count}`);
      let stopped = false, afterStop = 0;
      database(t, async sql => {
        if (stopped) afterStop++;
        if (sql.includes('FROM query_registry')) {
          if (sql.includes('WHERE seq IN')) {
            // 해시 스캔 뒤 원본이 삭제되면 읽을 본문이 없다. 이 I/O 중 종료 요청도 들어온다.
            stopped = true;
            isolated.requestSyncStop();
            return [];
          }
          return Array.from({ length: count }, (_, i) => ({ seq: i + 1, h: 'changed' }));
        }
        return [];
      });
      t.mock.method(globalThis, 'fetch', async () => assert.fail('삭제된 원본은 임베딩하지 않는다'));
      const result = await isolated.syncEmbeddings();
      assert.equal(afterStop, 0, '빈 배치 뒤에도 다음 본문 읽기를 시작하지 않는다');
      assert.equal(result.skipped, isolated.SKIP.STOPPED, '마지막 소스의 빈 배치도 종료 상태를 보존한다');
      assert.equal(result.embedded, 0);
      assert.equal(result.failed, 0);
    });
  }
});

test('청크 원문 스캔 전·도중 종료 요청은 추가 스캔을 시작하지 않는다', async t => {
  for (const stage of ['before-scan', 'during-scan']) {
    await t.test(stage, async t => {
      const isolated = await import(`../src/embed-sync.js?stop-chunk-scan-${stage}`);
      let stopped = stage === 'before-scan', afterStop = 0;
      if (stopped) isolated.requestSyncStop();
      database(t, async sql => {
        if (stopped) afterStop++;
        if (/FROM knowledge\s*$/.test(sql)) {
          isolated.requestSyncStop();
          stopped = true;
        }
        return [];
      });
      const result = await isolated.syncEmbeddings();
      assert.equal(afterStop, 0);
      assert.equal(result.skipped, isolated.SKIP.STOPPED);
      assert.equal(result.chunksFailed, 0);
    });
  }
});

test('고아 벡터 스캔·삭제 중 종료 요청은 다음 DB 작업을 멈추고 남은 정리를 복구한다', async t => {
  for (const stage of ['source-scan', 'vector-scan', 'delete-batch']) {
    await t.test(stage, async t => {
      const isolated = await import(`../src/embed-sync.js?stop-cleanup-${stage}`);
      const stored = new Set(Array.from({ length: 2001 }, (_, i) => i + 1));
      let stopped = false, afterStop = 0, deleted = 0;
      database(t, async (sql, params) => {
        if (stopped) afterStop++;
        const stop = () => { stopped = true; isolated.requestSyncStop(); };
        if (sql.includes('FROM query_registry')) {
          if (stage === 'source-scan') stop();
          return [];
        }
        if (sql.startsWith('SELECT seq, embed_hash FROM vec_query_registry')) {
          if (stage === 'vector-scan') stop();
          return [...stored].map(seq => ({ seq, embed_hash: 'old' }));
        }
        if (sql.startsWith('DELETE FROM vec_query_registry')) {
          let affectedRows = 0;
          for (const seq of params) if (stored.delete(seq)) affectedRows++;
          deleted += affectedRows;
          if (stage === 'delete-batch') stop();
          return { affectedRows };
        }
        return [];
      });
      t.mock.method(globalThis, 'fetch', async () => assert.fail('고아 정리는 임베딩하지 않는다'));
      const result = await isolated.syncEmbeddings();
      assert.equal(afterStop, 0, '종료 뒤 추가 스캔이나 삭제를 시작하지 않는다');
      assert.equal(result.skipped, isolated.SKIP.STOPPED, '마지막 소스에서도 종료 상태를 보존한다');
      assert.equal(result.deleted, stage === 'delete-batch' ? 1000 : 0);
      assert.equal(result.failed, 0);
      const remaining = stored.size;
      const recovered = await syncEmbeddings();
      assert.equal(recovered.deleted, remaining);
      assert.equal(stored.size, 0);
      assert.equal(deleted, 2001);
      assert.equal((await syncEmbeddings()).deleted, 0, '다시 실행해도 중복 정리하지 않는다');
    });
  }
});

test('청크 트랜잭션 중 종료 요청은 추가 쓰기를 멈추고 다음 실행이 문서 전체를 복구한다', async t => {
  const isolated = await import('../src/embed-sync.js?stop-chunk-write');
  const content = '긴 지식 문장입니다. '.repeat(700);
  let firstRun = true, writes = 0, rollbacks = 0, commits = 0;
  let pending = [], stored = [];
  database(t, async (sql, params) => {
    if (/FROM knowledge\s*$/.test(sql)) return [{ seq: 1, h: 'doc-hash' }];
    if (sql.includes('GROUP BY doc_seq')) return stored.length ? [{
      doc_seq: 1, h: 'doc-hash', max_h: 'doc-hash', n: stored.length,
      first_no: 1, last_no: stored.length, min_of: stored.length, max_of: stored.length,
    }] : [];
    if (sql.includes('FROM knowledge WHERE')) return [{ seq: 1, title: '긴 지식', content, h: 'doc-hash' }];
    if (sql.includes('INSERT INTO knowledge_chunk')) {
      writes++;
      pending.push({ chunk_no: params[1], chunk_of: params[2], content: params[5] });
      if (firstRun && writes === 1) isolated.requestSyncStop();
      return { affectedRows: 1 };
    }
    if (sql.startsWith('DELETE FROM knowledge_chunk')) return { affectedRows: 0 };
    return [];
  }, {
    beginTransaction: async () => { pending = []; },
    commit: async () => { stored = pending.slice(); commits++; },
    rollback: async () => { pending = []; rollbacks++; },
  });
  const first = await isolated.syncEmbeddings();
  assert.equal(writes, 1, '종료 신호 뒤 다른 청크를 쓰면 안 된다');
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.equal(first.chunks, 0);
  assert.equal(first.chunksFailed, 0, '정상 종료는 청크 실패가 아니다');
  assert.equal(first.skipped, isolated.SKIP.STOPPED);

  firstRun = false;
  const restarted = await import('../src/embed-sync.js?restart-chunk-write');
  const second = await restarted.syncEmbeddings();
  assert.ok(second.chunks > 1);
  assert.equal(stored.length, second.chunks);
  assert.ok(stored.every(row => row.chunk_of === stored.length));
  assert.equal((await restarted.syncEmbeddings()).chunks, 0);
});
