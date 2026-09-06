// 답변 미리보기(preview.js) 회귀 테스트 — 실행: npm test (frontend/)
import { test } from 'node:test';
import assert from 'node:assert';
import { PreviewPre, PLACEHOLDER } from '../src/preview.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

const renderPreview = text => renderToStaticMarkup(createElement(ReactMarkdown, { components: { pre: PreviewPre } }, text ?? ''));
const renderNormal = text => renderToStaticMarkup(createElement(ReactMarkdown, {}, text ?? ''));
const sameAs = (text, expected) => assert.equal(renderPreview(text), renderNormal(expected));

test('들여쓴 코드 예시의 chart·table·mermaid 글자를 미리보기에서 지우지 않는다', () => {
  for (const lang of ['chart', 'table', 'mermaid']) {
    const text = `    \`\`\`${lang}\n    사용법 예시\n    \`\`\`\n\n설명 문장`;
    const html = renderPreview(text);
    assert.ok(html.includes('사용법 예시'), html);
    assert.ok(html.includes(`<pre><code>\`\`\`${lang}`), html);
    assert.ok(html.includes('설명 문장'), html);
  }
});

test('목록의 미완성 참조 블록 뒤에서 목록 밖으로 나온 문장을 미리보기에서 보존한다', () => {
  const text = '- 결과\n\n  ```chart\n  data: step 1\n\n목록 밖의 정상 문장';
  const html = renderPreview(text);
  assert.ok(html.includes('준비하고 있습니다'), html);
  assert.ok(html.includes('<p>목록 밖의 정상 문장</p>'), html);
});

test('언어 이름이 chart·table·mermaid로 시작할 뿐이면 일반 코드로 보존한다', () => {
  for (const lang of ['chart-js', 'mermaid.example', 'table+html']) {
    const md = `\`\`\`${lang}\n설명 코드\n\`\`\``;
    sameAs(md, md);
  }
});

test('닫힌 chart·table·mermaid 펜스는 자리 표시로 바뀌고, 보통 코드와 글은 그대로다', () => {
  const md = '## 현황\n\n```chart\ntype: bar\ndata: step 1\n```\n\n글\n\n~~~table\nstep: 2\n~~~\n\n```js\ncode\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n끝';
  sameAs(md, `## 현황\n\n${PLACEHOLDER}\n\n글\n\n${PLACEHOLDER}\n\n\`\`\`js\ncode\n\`\`\`\n\n${PLACEHOLDER}\n\n끝`);
});

test('아직 닫히지 않은 마지막 펜스도 자리 표시다 — 반쯤 온 그림은 코드 원문으로 보인다', () => {
  sameAs('글\n\n```mermaid\nflowchart LR\n  A --', `글\n\n${PLACEHOLDER}`);
  sameAs('글\n\n  ```table\n  step: 1', `글\n\n  ${PLACEHOLDER}`);
  // 보통 코드 펜스는 열려 있어도 건드리지 않는다
  sameAs('```js\nlet a', '```js\nlet a');
});

test('빈 값과 펜스 없는 글은 그대로다', () => {
  sameAs('', '');
  sameAs(undefined, '');
  sameAs('| a | b |\n| 1 | 2', '| a | b |\n| 1 | 2');
});

test('여는 줄이 아직 끝나지 않은 펜스도 자리 표시다 — 모든 블록이 그 순간을 지난다', () => {
  // 조각은 아무 데서나 끊기므로 '```chart'까지만 온 순간이 반드시 있다. 그때 걸리지 않으면 한 프레임 동안
  // 빈 차트 상자나 그림의 원문이 보인다.
  sameAs('글\n\n```chart', `글\n\n${PLACEHOLDER}`);
  sameAs('글\n\n```mermaid', `글\n\n${PLACEHOLDER}`);
  sameAs('글\n\n  ~~~table', `글\n\n  ${PLACEHOLDER}`);
  sameAs('글\n\n```chart 월별', `글\n\n${PLACEHOLDER}`);
  // 다른 언어의 펜스와, 언어 이름이 이어지는 낱말인 경우는 건드리지 않는다
  sameAs('```js', '```js');
  sameAs('```charts', '```charts');
});

// 여는 펜스 반복으로 커진 미완성 블록도 자리 표시 하나로 접힌다. 원문을 다시 스캔하지 않고
// markdown 파서가 만든 하나의 코드 노드에서 처리한다.
test('여는 펜스가 반복되는 긴 미완성 블록도 자리 표시 하나로 그린다', () => {
  sameAs('```chart\ntype: bar\n'.repeat(7500), PLACEHOLDER);
});

// 보통 코드 펜스 안에 적힌 '```chart'는 펜스가 아니다 — 차트 문법을 설명하는 코드블록이 자리 표시로 바뀌면 안 된다.
test('보통 코드 펜스 안의 chart·table·mermaid 줄은 건드리지 않는다', () => {
  const md = '```markdown\n```chart\ntype: bar\n```\n\n```chart\ndata: step 1\n```';
  sameAs(md, `\`\`\`markdown\n\`\`\`chart\ntype: bar\n\`\`\`\n\n${PLACEHOLDER}`);
  // CRLF로 온 펜스도 닫힘을 알아본다
  sameAs('글\r\n```table\r\nstep: 1\r\n```\r\n끝', `글\n\n${PLACEHOLDER}\n\n끝`);
});

// 언어 이름의 대소문자. 그리는 쪽(App.jsx codeOf)·이력(chart.js CHART_FENCE_RE)·서버(backend chart.js)가 모두 가리지
// 않는데 여기만 가리면, ```Chart 블록이 미리보기에서 자리 표시가 아니라 차트로 그려져 '조회 결과를 채우지 못했습니다'라는
// 거짓 안내가 답이 오기까지 떠 있고, 반쯤 온 ```Mermaid 는 그림으로 그려져 파스 오류 경고를 콘솔에 남긴다(실측).
test('펜스의 언어 이름은 대소문자를 가리지 않는다 — 그리는 쪽과 같은 규칙이다', () => {
  sameAs('글\n\n```Chart\ntype: bar\ndata: step 1\n```', `글\n\n${PLACEHOLDER}`);
  sameAs('글\n\n```MERMAID\nflowchart LR\n  A --', `글\n\n${PLACEHOLDER}`);
  sameAs('~~~Table\nstep: 1\n~~~', PLACEHOLDER);
  sameAs('```Charts\nx', '```Charts\nx');
});
