// 응답 스트림 읽기(stream.js) 회귀 테스트 — 실행: npm test (frontend/)
// 줄 경계의 실패는 네트워크가 조각을 어떻게 나누느냐에 달려 있어 화면에서는 재현되지 않는다 —
// 여기서 조각을 일부러 나눠 넣는다.
import { test } from 'node:test';
import assert from 'node:assert';
import { eventOf, isFinal, readEvents } from '../src/stream.js';

test('JSON 응답은 들여쓰기와 여러 줄이 있어도 객체 전체를 읽는다', async () => {
  const data = { answer: '정상 답변', trace: [{ rows: [{ VALUE: 7 }] }] };
  for (const body of [true, false]) {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    const res = body ? new Response(JSON.stringify(data, null, 2), { headers })
      : { ...chunked([JSON.stringify(data, null, 2)], { body }), headers };
    assert.deepStrictEqual(await readEvents(res), data);
  }
});

test('done 뒤 연결이 열려 있어도 답을 반환하고 스트림을 정리한다', async () => {
  let cancelled = false;
  const res = { body: new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"type":"done","answer":"완료"}\n')); },
    cancel() { cancelled = true; },
  }) };
  let timer;
  try {
    const final = await Promise.race([
      readEvents(res),
      new Promise(resolve => { timer = setTimeout(() => resolve('응답 대기 중'), 500); }),
    ]);
    assert.deepStrictEqual(final, { type: 'done', answer: '완료' });
    assert.ok(cancelled, '완료한 응답의 스트림이 남았다');
    assert.equal(res.body.locked, false);
  } finally { clearTimeout(timer); }
});

test('마지막 이벤트 뒤의 줄은 완성된 답을 덮거나 진행 상태를 바꾸지 않는다', async () => {
  const seen = [];
  const final = await readEvents(chunked([
    '{"type":"done","answer":"완료"}\n{"type":"answer_delta","text":"늦은 조각"}\n{"error":"늦은 오류"}\n',
  ]), e => seen.push(e));
  assert.deepStrictEqual(final, { type: 'done', answer: '완료' });
  assert.deepStrictEqual(seen, []);
});

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
  // 재는 자리에 잡음이 많다: 1MB는 몇 ms짜리라 Date.now()(1ms 눈금)로는 한 눈금이 곧 30% 오차이고,
  // GC나 다른 프로세스가 한 번만 끼어도 4MB 쪽이 통째로 늘어난다. 눈금을 performance.now로 바꾸고
  // 여러 번 재어 중앙값을 써도 모자랐다 — 두 크기를 '따로' 재는 한, 오래 도는 쪽(4MB)이 방해를 그만큼
  // 더 받아 비가 커진다(실측: 중앙값 5회로도 부하 평균 63에서 3.6ms → 32.8ms = 9.1배로 깨졌다.
  // 같은 순간의 같은 코드가 1·2·4·8MB에서 3.6·7.5·16.9·37.1ms, 곱마다 2.1배로 선형이었다).
  //
  // 그래서 '같은 총 바이트'로 비교한다: 1MB 여덟 번과 8MB 한 번은 처리해야 할 바이트가 같으므로,
  // take()가 선형이면 두 시간이 같고(비 1), 조각마다 쌓인 전체를 다시 훑으면 한 줄짜리 쪽만 배로 든다.
  // 방해도 양쪽이 같은 시간만큼 받으므로 부하가 비를 밀지 않는다 — 실측(부하 평균 73):
  // 비 1.02·0.93·1.13·0.78·0.87. 쌓아 두고 다시 훑는 돌연변이에서는 6.5였다.
  const ms = async mb => { const t0 = performance.now(); const f = await readEvents(bodyOf(mb)); assert.equal(f.type, 'done'); return performance.now() - t0; };
  // 한 번씩만 재면 그 한 번이 방해를 받는 것까지는 못 막는다(실측: 부하 평균 74에서 4MB 한 번이
  // 13ms 대신 40ms). 양쪽을 세 번씩 재어 '최소'를 쓴다 — 가장 덜 방해받은 실행이 참값에 가깝고,
  // 제곱이 되면 최소값도 함께 커진다.
  await ms(1); await ms(8);          // 워밍업 (JIT 편차 제거)
  let split = Infinity, whole = Infinity;
  for (let round = 0; round < 3; round++) {
    let eight = 0;
    for (let i = 0; i < 8; i++) eight += await ms(1);  // 1MB 여덟 번
    split = Math.min(split, eight);
    whole = Math.min(whole, await ms(8));              // 같은 바이트를 한 줄로
  }
  // 선형이면 1 남짓이고 제곱이면 여러 배다. 느린 기계에서도 갈리도록 넉넉히 2배로 둔다.
  assert.ok(whole < split * 2, `같은 바이트인데 한 줄로 오면 ${(whole / split).toFixed(1)}배 든다 — 조각마다 전부 다시 훑고 있다 (1MB×8 ${split.toFixed(1)}ms → 8MB×1 ${whole.toFixed(1)}ms)`);
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
