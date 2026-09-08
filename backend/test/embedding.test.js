// 임베딩 클라이언트 회귀 테스트 — 실행: npm test
// 임베딩 실패는 검색 전체를 '검색 불가'로 만들고 그 원인은 로그 한 줄뿐이다. 그 줄이 원인을 말해야 한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { vector } from './fixtures/vector.js';

process.env.EMBEDDING_URL = 'http://test.invalid/v1';
const { embed, EmbeddingError } = await import('../src/embedding.js');

test('잘못된 차원·영벡터·FP32 범위를 벗어난 벡터를 저장과 캐시 전에 거부한다', async t => {
  for (const bad of [[], [1, 0], vector().slice(1), [...vector(), 0],
    Array(1024).fill(0), Array(1024).fill(1e-50), Array(1024).fill(1e38),
    [1e40, ...Array(1023).fill(0)]]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: bad }] })));
    await assert.rejects(embed(['invalid']), e => e instanceof EmbeddingError && !e.retriable);
  }
});

test('잘못된 응답 구조와 숫자가 아닌 벡터를 영구 응답 오류로 거부한다', async () => {
  const invalid = [
    null, { data: {} }, { data: [null] },
    ...[[null], ['1'], [true], [0, {}], []].map(embedding => ({ data: [{ index: 0, embedding }] })),
  ];
  for (const body of invalid) {
    globalThis.fetch = async () => new Response(JSON.stringify(body));
    await assert.rejects(embed(['a']), e => e instanceof EmbeddingError && e.retriable === false, JSON.stringify(body));
  }
  // JSON 문법상 유효한 큰 지수도 JS에서는 Infinity가 된다.
  globalThis.fetch = async () => new Response('{"data":[{"index":0,"embedding":[1e400]}]}');
  await assert.rejects(embed(['a']), e => e instanceof EmbeddingError && e.retriable === false);
});

test('임베딩 index 중복·누락·범위 오류는 원문과 벡터를 잘못 짝짓지 않는다', async () => {
  for (const indices of [[0, 0], [1, 2], [-1, 0], [0, 0.5], [undefined, undefined]]) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: indices.map((index, position) => ({ index, embedding: vector(position) })),
    }));
    await assert.rejects(embed(['a', 'b']), error =>
      error instanceof EmbeddingError && error.retriable === false, JSON.stringify(indices));
  }
});

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
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: vector(1) }, { index: 0, embedding: vector() }] }), { status: 200 });
  assert.deepEqual(await embed(['a', 'b']), [vector(), vector(1)]);
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: vector() }] }), { status: 200 });
  await assert.rejects(embed(['a', 'b']), e => e instanceof EmbeddingError && e.retriable === false);
});

test('임베딩은 각도를 보존하는 FP32 단위 벡터로 반환한다', async t => {
  const raw = vector(); raw[0] = 3; raw[1] = 4;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: raw }] })));
  const [v] = await embed(['normalization']);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
  assert.ok(Math.abs(v.reduce((sum, n) => sum + n * n, 0) - 1) < 1e-6);
});
