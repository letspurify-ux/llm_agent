// 응답 스트림 읽기(stream.js) 회귀 테스트 — 실행: npm test (frontend/)
// 줄 경계의 실패는 네트워크가 조각을 어떻게 나누느냐에 달려 있어 화면에서는 재현되지 않는다 —
// 여기서 조각을 일부러 나눠 넣는다.
import { test } from 'node:test';
import assert from 'node:assert';
import { eventOf, isFinal, readEvents } from '../src/stream.js';

// 바이트 조각들을 주는 가짜 응답. 진짜 Response도 쓸 수 있지만, 조각 경계를 정확히 정하려면 스트림을 직접 만든다.
const chunked = (chunks, { body = true } = {}) => {
  const enc = new TextEncoder();
  if (!body) return { text: async () => chunks.join('') };
  return {
    body: new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch); c.close(); },
    }),
  };
};

test('CR과 빈 줄과 JSON 아닌 줄은 버리고, 개행 없이 끝난 줄도 읽는다', () => {
  // 줄 나누기는 이제 한 곳뿐이다 (readEvents 안의 증분 분해기) — 스트림으로 오는 길과 통째로 오는 길이
  // 서로 다른 분해기를 지나면 한쪽만 조용히 어긋난다. 그래서 두 길을 같은 입력으로 함께 잰다.
  const text = '{"type":"search","text":"a"}\r\n\n<html>oops</html>\n{"type":"done","answer":"끝"}';
  return Promise.all([
    readEvents(chunked([text])),                       // 스트림
    readEvents(chunked([text], { body: false })),      // 통째로 (예전 JSON 응답과 같은 길)
  ]).then(([a, b]) => {
    assert.deepStrictEqual(a, { type: 'done', answer: '끝' });
    assert.deepStrictEqual(b, a, '두 길이 다른 것을 돌려줬다');
  });
});

test('두 길은 어떤 조각 경계에서도 같은 이벤트를 낸다', async () => {
  const text = '{"type":"search","text":"가나다"}\n{"type":"run_query","id":1,"query_name":"q"}\r\n: ping\n{"type":"done","answer":"끝"}\n';
  const bytes = new TextEncoder().encode(text);
  const whole = [];
  await readEvents(chunked([text], { body: false }), e => whole.push(e));
  for (const size of [1, 2, 3, 5, 7, 13, 64]) {
    const seen = [];
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
    const final = await readEvents(chunked(chunks), e => seen.push(e));
    assert.deepStrictEqual(seen, whole, `조각 ${size}바이트에서 이벤트가 달라졌다`);
    assert.deepStrictEqual(final, { type: 'done', answer: '끝' });
  }
});

test('객체가 아닌 줄은 이벤트가 아니다', () => {
  assert.equal(eventOf('[1,2]'), null);
  assert.equal(eventOf('"str"'), null);
  assert.equal(eventOf('null'), null);
  assert.equal(eventOf('42'), null);
  assert.deepStrictEqual(eventOf('{"a":1}'), { a: 1 });
});

test('마지막 이벤트는 done·error, 그리고 type 없는 예전 응답이다', () => {
  assert.ok(isFinal({ type: 'done' }) && isFinal({ type: 'error' }) && isFinal({ answer: 'a' }));
  assert.ok(!isFinal({ type: 'search' }) && !isFinal({ type: 'run_query_done' }));
});

test('조각이 줄 한가운데·글자 한가운데에서 갈라져도 이벤트를 잃지 않는다', async () => {
  const text = '{"type":"search","text":"배치 재시작"}\n{"type":"search_done","hits":{"knowledge":2}}\n{"type":"done","answer":"답","trace":[]}\n';
  const bytes = new TextEncoder().encode(text);
  // 한글 한 글자(3바이트)의 가운데에서 자른다 — 디코더가 stream 모드가 아니면 여기서 U+FFFD가 생긴다
  const cut = text.indexOf('재') + 1;
  const cutBytes = new TextEncoder().encode(text.slice(0, cut)).length + 1;
  const chunks = [bytes.slice(0, cutBytes), bytes.slice(cutBytes, cutBytes + 40), bytes.slice(cutBytes + 40)];
  const seen = [];
  const final = await readEvents(chunked(chunks), e => seen.push(e));
  assert.deepStrictEqual(seen, [{ type: 'search', text: '배치 재시작' }, { type: 'search_done', hits: { knowledge: 2 } }]);
  assert.deepStrictEqual(final, { type: 'done', answer: '답', trace: [] });
});

test('마지막 줄에 개행이 없어도, 스트림이 없어도 같은 값을 돌려준다', async () => {
  const noNewline = await readEvents(chunked(['{"type":"done","answer":"a"}']));
  assert.deepStrictEqual(noNewline, { type: 'done', answer: 'a' });
  // 예전 서버(또는 검사의 가로채기)가 주는 JSON 하나 — type이 없어도 마지막이다
  const legacy = await readEvents(chunked(['{"answer":"a","trace":[]}'], { body: false }));
  assert.deepStrictEqual(legacy, { answer: 'a', trace: [] });
  // done이 오지 않은 채 닫히면 null — 통신 실패로 다뤄야 한다
  assert.equal(await readEvents(chunked(['{"type":"search","text":"x"}\n'])), null);
});

test('진행 표시가 던져도 읽기는 계속되고 마지막 이벤트가 온다', async () => {
  const final = await readEvents(chunked(['{"type":"search","text":"x"}\n{"type":"done","answer":"a"}\n']), () => { throw new Error('boom'); });
  assert.deepStrictEqual(final, { type: 'done', answer: 'a' });
});

test('오류 줄은 마지막 이벤트이고 그 뒤는 읽지 않아도 된다', async () => {
  const seen = [];
  const final = await readEvents(chunked(['{"type":"search","text":"x"}\n{"type":"error","error":"처리 중 오류"}\n']), e => seen.push(e));
  assert.equal(seen.length, 1);
  assert.deepStrictEqual(final, { type: 'error', error: '처리 중 오류' });
});

test('마지막 줄이 아주 길어도 비용이 길이에 비례한다 — 조각마다 전부 다시 훑지 않는다', async () => {
  // done 줄에는 조회된 행이 전부 실린다(서버 result.js clientTrace) — 한 줄이 수 MB일 수 있고, 그 줄이
  // 오는 동안에는 개행이 없다. 쌓인 전체를 조각마다 다시 훑으면 비용이 길이의 제곱이 되어, 답이 도착하는
  // 바로 그 순간 화면이 수백 ms 멈춘다(실측: 4MB에 569ms, 길이를 두 배로 하면 네 배).
  const enc = new TextEncoder();
  const bodyOf = mb => {
    const filler = 'x'.repeat(mb * 1024 * 1024);
    const line = `${JSON.stringify({ type: 'done', answer: filler })}\n`;
    const bytes = enc.encode(line);
    const CHUNK = 16 * 1024;
    return { body: new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += CHUNK) c.enqueue(bytes.slice(i, i + CHUNK)); c.close(); } }) };
  };
  const ms = async mb => { const t0 = Date.now(); const f = await readEvents(bodyOf(mb)); assert.equal(f.type, 'done'); return Date.now() - t0; };
  await ms(1);                       // 워밍업 (JIT 편차 제거)
  const one = Math.max(1, await ms(1));
  const four = await ms(4);
  // 선형이면 4배 남짓, 제곱이면 16배가 된다. 느린 기계에서도 갈리도록 넉넉히 8배로 둔다.
  assert.ok(four < one * 8, `길이가 4배인데 비용이 ${(four / one).toFixed(1)}배다 — 조각마다 전부 다시 훑고 있다 (${one}ms → ${four}ms)`);
});

test('답을 다 읽은 뒤 스트림이 끊겨도 그 답을 버리지 않는다', async () => {
  // 서버가 마지막 줄을 보낸 뒤 연결이 끊기는 일이 있다(마지막 쓰기와 FIN 사이의 리셋, 그 틈에 걸린 요청 상한).
  // 그때 던지면 사용자가 몇십 초 기다린 답이 '서버와 통신하지 못했습니다'로 사라진다.
  const enc = new TextEncoder();
  const res = { body: new ReadableStream({
    start(c) { c.enqueue(enc.encode(`${JSON.stringify({ type: 'done', answer: '완성된 답' })}\n`)); },
    pull(c) { c.error(new TypeError('network error')); },
  }) };
  assert.deepStrictEqual(await readEvents(res), { type: 'done', answer: '완성된 답' });
  // 답을 읽기 전에 끊긴 것은 그대로 실패다 — 그때는 통신 실패가 맞다
  const early = { body: new ReadableStream({
    start(c) { c.enqueue(enc.encode(`${JSON.stringify({ type: 'search', text: 'x' })}\n`)); },
    pull(c) { c.error(new TypeError('network error')); },
  }) };
  await assert.rejects(() => readEvents(early), /network error/);
});
