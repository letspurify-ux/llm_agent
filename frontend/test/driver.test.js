// UI 드라이버의 판정 중 브라우저 없이 확인할 수 있는 것 — 실행: npm test (frontend/)
//
// 여기서 지키는 것은 '기다릴 것과 곧바로 알릴 것을 무엇으로 가르는가'이다. 잘못 가르면 두 방향으로
// 조용히 어긋난다: 지나가는 오류를 치명으로 읽으면 통과했을 검사가 애먼 말과 함께 죽고, 진짜 오타를
// 삼키면 15초를 기다린 끝에 엉뚱한 자리를 탓하는 말이 나온다. 둘 다 검사 결과만 보고는 알 수 없다.
import { test } from 'node:test';
import assert from 'node:assert';
import { errorName } from './ui/driver.mjs';

test('오류는 이름으로 가른다 — 스택에 섞인 남의 이름에 속지 않는다', () => {
  // CDP가 이름(className)을 준다. 그것이 있으면 그것이 답이다.
  assert.strictEqual(errorName({ className: 'ReferenceError', message: '__x__ is not defined\n    at <anonymous>' }), 'ReferenceError');
  assert.strictEqual(errorName({ className: 'SyntaxError', message: 'Unexpected token' }), 'SyntaxError');
  // 메시지(description)는 스택까지 담은 글자다 — 거기서 'ReferenceError'를 찾던 때에는 번들 모듈
  // 이름이나 앱이 낸 문자열 하나로 지나가는 TypeError가 치명이 되었다.
  assert.strictEqual(errorName({ className: 'TypeError', message: "TypeError: ReferenceError: 흉내\n    at x (a.js:1:1)" }), 'TypeError');
  // 이름이 없으면 첫 줄의 앞부분만 본다 (그 뒤는 스택이다)
  assert.strictEqual(errorName({ message: 'TypeError: 어쩌고\n    at referenceErrorHelper (a.js:1:1)' }), 'TypeError');
  assert.strictEqual(errorName({ className: null, message: 'SyntaxError: Unexpected token' }), 'SyntaxError');
  // 이름을 알 수 없는 것은 빈 문자열이다 — 치명으로도 읽지 않는다(CDP 프로토콜 오류 등은 지나간다)
  assert.strictEqual(errorName({ message: '{"code":-32000,"message":"Cannot find context with specified id"}' }), '');
  assert.strictEqual(errorName({ message: '브라우저와의 연결이 끊겼습니다' }), '');
  assert.strictEqual(errorName(undefined), '');
});
