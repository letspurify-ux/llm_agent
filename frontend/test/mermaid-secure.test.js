// Mermaid.jsx가 mermaid의 기본 secure 목록을 실제로 이어받는가.
//
// Mermaid.jsx는 답변 본문의 지시문(`%%{init: {…}}%%`)·머리말이 설정을 덮어쓰지 못하게 할 키 목록을
// 이렇게 만든다:
//
//   secure: [...(mermaid.mermaidAPI?.defaultConfig?.secure ?? []), 'htmlLabels']
//
// `?? []`가 조용한 자리다. mermaid가 mermaidAPI를 옮기거나 defaultConfig의 모양을 바꾸면 이 식은
// 오류 없이 ['htmlLabels'] 하나가 되고, 그 순간 기본 목록에 있던 securityLevel이 지켜지지 않는다 —
// 모델이(또는 모델이 베낀 조회 결과가) `%%{init: {"securityLevel": "loose"}}%%` 한 줄을 쓰면 라벨이
// 다시 HTML이 되어 <img src>가 서고, 사용자가 누르기도 전에 모델이 쓴 주소가 불려 나간다.
// 그 퇴화는 화면에서도 콘솔에서도 보이지 않는다(그림은 그대로 그려진다) — 그래서 여기서 잡는다.
//
// 이 검사가 깨지면 mermaid의 새 API 자리를 찾아 Mermaid.jsx의 식을 고칠 것. 목록을 통째로 손으로
// 적어 넣는 것은 답이 아니다(그러면 mermaid가 키를 더한 날 그것을 조용히 잃는다 — Mermaid.jsx 주석).
import { test } from 'node:test';
import assert from 'node:assert';
import mermaid from 'mermaid';

test('mermaid의 기본 secure 목록을 이어받을 수 있다 — 지시문이 securityLevel을 덮어쓰지 못한다', () => {
  const base = mermaid.mermaidAPI?.defaultConfig?.secure;
  assert.ok(Array.isArray(base) && base.length > 0,
    `mermaid의 기본 secure 목록을 찾지 못했다(${JSON.stringify(base)}) — Mermaid.jsx의 '?? []'가 그 목록을 통째로 잃는다`);
  assert.ok(base.includes('securityLevel'),
    `기본 secure 목록에 securityLevel이 없다: ${JSON.stringify(base)} — 답변의 지시문이 라벨을 다시 HTML로 되돌릴 수 있다`);
  // Mermaid.jsx가 실제로 거는 목록과 같은 방식으로 이어 붙여, 우리가 더한 키까지 함께 남는지 본다.
  const secure = [...(mermaid.mermaidAPI?.defaultConfig?.secure ?? []), 'htmlLabels'];
  assert.ok(secure.includes('securityLevel') && secure.includes('htmlLabels'),
    `Mermaid.jsx가 거는 목록이 두 키를 함께 지키지 못한다: ${JSON.stringify(secure)}`);
});
