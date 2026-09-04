// 서버 응답을 읽는 계약 — 진행 상황 스트림(NDJSON, 한 줄에 이벤트 하나)과 예전 그대로의 JSON 하나를 같은
// 함수가 읽는다. App.jsx가 아니라 여기 있는 이유는 chart.js·trace.js와 같다: 순수 함수라 node:test로
// 회귀 테스트가 붙는다. 줄 경계에서 조각이 어긋나면 답이 통째로 사라지는데, 그 실패는 네트워크가 조각을
// 어떻게 나눠 주느냐에 달려 있어 화면에서는 재현되지 않는다.
//
// 서버는 마지막 줄로 done({answer, trace})이나 error({error})를 준다(backend server.js openStream).
// type이 없는 객체는 예전 응답(JSON 하나)이다 — 그것도 '마지막'으로 본다. 그래서 App.jsx는 스트림이든
// 아니든 같은 값을 받는다: 마지막 객체 하나.

// 한 줄 → 이벤트 객체. 객체가 아니면(배열·문자열·숫자·null) 없는 것으로 본다 — 화면이 그릴 수 있는 것은 객체뿐이다.
export function eventOf(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// '마지막' 이벤트인가 — 답이거나 오류거나, type이 없는 예전 응답이거나.
export const isFinal = e => e.type === 'done' || e.type === 'error' || e.type === undefined;

// 응답 본문을 끝까지 읽는다. 진행 이벤트마다 onEvent를 부르고, 마지막 이벤트(done/error/예전 JSON)를 돌려준다.
// 없으면 null — 서버가 done 없이 닫았다(중간에 죽었다)는 뜻이고, 부르는 쪽이 통신 실패로 다룬다.
// 본문 스트림을 못 주는 환경(구형 브라우저·일부 테스트 더블)에서는 text()로 통째로 받아 같은 파서에 넣는다 —
// 두 길이 같은 함수를 지나야 한쪽만 조용히 어긋나지 않는다.
// 진행 이벤트를 받는 쪽이 던져도 읽기는 계속한다 — 화면 표시 하나가 답을 잃게 하면 안 된다.
export async function readEvents(res, onEvent) {
  let final = null;
  const feed = events => {
    for (const e of events) {
      if (isFinal(e)) { final = e; continue; }
      try { onEvent?.(e); } catch (err) { console.warn('[stream] 진행 표시에 실패했습니다:', err); }
    }
  };

  // 줄 나누기는 한 곳뿐이다. 스트림으로 오는 길과 통째로 오는 길(예전 JSON 응답, 본문 스트림이 없는 환경)이
  // 서로 다른 분해기를 지나면 한쪽만 조용히 어긋나고, 그 어긋남은 '어떤 서버에서만 답이 안 보인다'로 나타난다.
  //
  // 개행은 '이번 조각 안에서만' 찾고, 줄이 끝날 때까지는 조각을 이어 붙이지 않고 모아 둔다.
  // 쌓인 문자열에 indexOf를 다시 거는 방식으로는 부족하다: 이어 붙인 문자열은 V8에서 rope로 남아 있다가
  // indexOf가 불릴 때마다 평탄화되므로, 조각마다 전체를 훑는 것과 같아진다(실측: 그 방식으로도 1MB 6ms
  // → 4MB 54ms로 아홉 배). 마지막 done 줄에는 조회된 행이 전부 실려(서버 result.js clientTrace) 한 줄이
  // 수 MB일 수 있고, 그 줄이 오는 동안에는 개행이 없다 — 답이 도착하는 바로 그 순간 화면이 그만큼 멈춘다.
  //
  // CR은 뗀다(프록시가 CRLF로 바꾸는 일이 있다). 빈 줄과 JSON이 아닌 줄은 버린다 — 프록시의 오류 페이지
  // 조각이나 keep-alive 빈 줄이 그 길로 들어오는데, 그런 줄 하나로 응답 전체를 잃을 이유가 없다.
  const parts = [];   // 아직 개행을 만나지 못한 조각들 (줄이 끝날 때 한 번만 이어 붙인다)
  const take = piece => {
    const events = [];
    let start = 0;
    for (let nl = piece.indexOf('\n'); nl >= 0; nl = piece.indexOf('\n', start)) {
      parts.push(piece.slice(start, nl));
      const line = parts.join('').replace(/\r$/, '').trim();
      parts.length = 0;
      start = nl + 1;
      if (!line) continue;
      const e = eventOf(line);
      if (e) events.push(e);
    }
    if (start < piece.length) parts.push(piece.slice(start));
    return events;
  };

  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(take(decoder.decode(value, { stream: true })));
      }
      feed(take(decoder.decode()));
    } catch (e) {
      // 이미 마지막 이벤트를 읽었으면 그것을 돌려준다 — 서버가 답을 다 보낸 뒤 연결이 끊기는 일이 있는데
      // (마지막 쓰기와 FIN 사이의 리셋, 그 틈에 걸린 요청 상한), 그때 던지면 사용자가 기다린 답을
      // '서버와 통신하지 못했습니다'로 버리게 된다.
      if (!final) throw e;
      return final;
    }
  } else {
    feed(take(await res.text()));
  }
  // 마지막 줄에 개행이 없어도 읽는다 — 예전 JSON 응답과 개행 없이 닫힌 스트림이 이 길이다
  feed(take('\n'));
  return final;
}
