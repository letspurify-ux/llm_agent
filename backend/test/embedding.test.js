// 임베딩 클라이언트 회귀 테스트 — 실행: npm test
// 임베딩 실패는 검색 전체를 '검색 불가'로 만들고 그 원인은 로그 한 줄뿐이다. 그 줄이 원인을 말해야 한다.
import { test } from 'node:test';
import assert from 'node:assert';

process.env.EMBEDDING_URL = 'http://test.invalid/v1';
const { embed, EmbeddingError } = await import('../src/embedding.js');

test('접속 실패는 fetch failed 뒤에 원인이 붙고 재시도 대상이다', async () => {
  const cause = Object.assign(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:11434')], ''), { code: 'ECONNREFUSED' });
  globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause }); };
  await assert.rejects(embed(['x']), e => e instanceof EmbeddingError && e.retriable === true && /fetch failed — connect ECONNREFUSED 127\.0\.0\.1:11434/.test(e.message));
});

test('응답이 상한 시간 안에 오지 않으면 그 사실을 문구로 말한다 — "This operation was aborted"가 아니라', async () => {
  // 60초 타이머만 즉시 발화시킨다 — node:test의 mock.timers는 Node 20.11/21.2부터 옵션 객체 서명이라, 이 저장소가
  // engines 제약 없이 지원하는 버전 폭에서는 setTimeout을 직접 갈아 끼우는 쪽이 어느 버전에서든 같게 돈다.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => (ms === 60_000 ? realSetTimeout(fn, 0, ...args) : realSetTimeout(fn, ms, ...args));
  try {
    // 신호가 끊길 때까지 답하지 않는 서버 — 우리 타이머가 끊으면 fetch는 AbortError를 던진다
    globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
    });
    await assert.rejects(embed(['x']), e => e instanceof EmbeddingError && e.retriable === true && /60초 안에 끝나지 않았습니다/.test(e.message));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('4xx는 재시도 대상이 아니고 5xx·429는 재시도 대상이다', async () => {
  for (const [status, retriable] of [[400, false], [404, false], [429, true], [500, true], [503, true]]) {
    globalThis.fetch = async () => new Response('{"error":"x"}', { status });
    await assert.rejects(embed(['x']), e => e instanceof EmbeddingError && e.retriable === retriable && e.message.includes(String(status)), `status ${status}`);
  }
});

test('응답 항목은 index로 짝짓고 개수·모양이 어긋나면 재시도하지 않는다', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }), { status: 200 });
  assert.deepEqual(await embed(['a', 'b']), [[1], [2]]);
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
  await assert.rejects(embed(['a', 'b']), e => e instanceof EmbeddingError && e.retriable === false);
});
