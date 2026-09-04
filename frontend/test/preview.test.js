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
