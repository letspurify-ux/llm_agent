// 답변 미리보기(preview.js) 회귀 테스트 — 실행: npm test (frontend/)
import { test } from 'node:test';
import assert from 'node:assert';
import { previewMarkdown, PLACEHOLDER } from '../src/preview.js';

test('닫힌 chart·table·mermaid 펜스는 자리 표시로 바뀌고, 보통 코드와 글은 그대로다', () => {
  const md = '## 현황\n\n```chart\ntype: bar\ndata: step 1\n```\n\n글\n\n~~~table\nstep: 2\n~~~\n\n```js\ncode\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n끝';
  assert.equal(previewMarkdown(md), `## 현황\n\n${PLACEHOLDER}\n\n글\n\n${PLACEHOLDER}\n\n\`\`\`js\ncode\n\`\`\`\n\n${PLACEHOLDER}\n끝`);
});

test('아직 닫히지 않은 마지막 펜스도 자리 표시다 — 반쯤 온 그림은 코드 원문으로 보인다', () => {
  assert.equal(previewMarkdown('글\n\n```mermaid\nflowchart LR\n  A --'), `글\n\n${PLACEHOLDER}`);
  assert.equal(previewMarkdown('글\n\n  ```table\n  step: 1'), `글\n\n  ${PLACEHOLDER}`, '들여쓰기는 남는다');
  // 보통 코드 펜스는 열려 있어도 건드리지 않는다
  assert.equal(previewMarkdown('```js\nlet a'), '```js\nlet a');
});

test('빈 값과 펜스 없는 글은 그대로다', () => {
  assert.equal(previewMarkdown(''), '');
  assert.equal(previewMarkdown(undefined), '');
  assert.equal(previewMarkdown('| a | b |\n| 1 | 2'), '| a | b |\n| 1 | 2');
});

test('여는 줄이 아직 끝나지 않은 펜스도 자리 표시다 — 모든 블록이 그 순간을 지난다', () => {
  // 조각은 아무 데서나 끊기므로 '```chart'까지만 온 순간이 반드시 있다. 그때 걸리지 않으면 한 프레임 동안
  // 빈 차트 상자나 그림의 원문이 보인다.
  assert.equal(previewMarkdown('글\n\n```chart'), `글\n\n${PLACEHOLDER}`);
  assert.equal(previewMarkdown('글\n\n```mermaid'), `글\n\n${PLACEHOLDER}`);
  assert.equal(previewMarkdown('글\n\n  ~~~table'), `글\n\n  ${PLACEHOLDER}`);
  assert.equal(previewMarkdown('글\n\n```chart 월별'), `글\n\n${PLACEHOLDER}`);
  // 다른 언어의 펜스와, 언어 이름이 이어지는 낱말인 경우는 건드리지 않는다
  assert.equal(previewMarkdown('```js'), '```js');
  assert.equal(previewMarkdown('```charts'), '```charts');
});

// 여는 줄만 되풀이하는 퇴화한 응답에서 비용이 줄 수의 제곱이었다 — 답변 상한 안의 7,500줄이 한 번에 390ms였고,
// 미리보기는 120ms마다 자라난 전체를 다시 손보므로 스트림이 끝날 때까지 화면이 멈췄다(실측). 백엔드 파서가
// '<think' 반복에서 겪은 것과 같은 부류다.
test('여는 펜스가 아무리 많아도 비용이 길이에 비례한다', () => {
  const degenerate = n => '```chart\ntype: bar\n'.repeat(n);
  const ms = n => { const t0 = performance.now(); previewMarkdown(degenerate(n)); return performance.now() - t0; };
  ms(2000);                                   // 워밍업 (JIT 편차 제거)
  const one = Math.max(0.5, ms(2000));
  const four = ms(8000);
  // 선형이면 4배 남짓, 제곱이면 16배가 된다. 느린 기계에서도 갈리도록 넉넉히 8배로 둔다.
  assert.ok(four < one * 8, `길이가 4배인데 비용이 ${(four / one).toFixed(1)}배다 (${one.toFixed(1)}ms → ${four.toFixed(1)}ms)`);
  // 결과도 같아야 한다 — 열린 채 끝난 블록 하나로 접힌다
  assert.equal(previewMarkdown(degenerate(3)), PLACEHOLDER);
});

// 보통 코드 펜스 안에 적힌 '```chart'는 펜스가 아니다 — 차트 문법을 설명하는 코드블록이 자리 표시로 바뀌면 안 된다.
test('보통 코드 펜스 안의 chart·table·mermaid 줄은 건드리지 않는다', () => {
  const md = '```markdown\n```chart\ntype: bar\n```\n\n```chart\ndata: step 1\n```';
  assert.equal(previewMarkdown(md), `\`\`\`markdown\n\`\`\`chart\ntype: bar\n\`\`\`\n\n${PLACEHOLDER}`);
  // CRLF로 온 펜스도 닫힘을 알아본다
  assert.equal(previewMarkdown('글\r\n```table\r\nstep: 1\r\n```\r\n끝'), `글\r\n${PLACEHOLDER}\n끝`);
});

// 언어 이름의 대소문자. 그리는 쪽(App.jsx codeOf)·이력(chart.js CHART_FENCE_RE)·서버(backend chart.js)가 모두 가리지
// 않는데 여기만 가리면, ```Chart 블록이 미리보기에서 자리 표시가 아니라 차트로 그려져 '조회 결과를 채우지 못했습니다'라는
// 거짓 안내가 답이 오기까지 떠 있고, 반쯤 온 ```Mermaid 는 그림으로 그려져 파스 오류 경고를 콘솔에 남긴다(실측).
test('펜스의 언어 이름은 대소문자를 가리지 않는다 — 그리는 쪽과 같은 규칙이다', () => {
  assert.equal(previewMarkdown('글\n\n```Chart\ntype: bar\ndata: step 1\n```'), `글\n\n${PLACEHOLDER}`);
  assert.equal(previewMarkdown('글\n\n```MERMAID\nflowchart LR\n  A --'), `글\n\n${PLACEHOLDER}`);
  assert.equal(previewMarkdown('~~~Table\nstep: 1\n~~~'), PLACEHOLDER);
  assert.equal(previewMarkdown('```Charts\nx'), '```Charts\nx', '이어지는 낱말은 여전히 다른 언어다');
});
