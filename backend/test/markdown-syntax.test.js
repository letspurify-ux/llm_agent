import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChartData, resolveTableData } from '../src/chart.js';

const steps = [[{ A: 'FOUND_ROW', B: 7 }]];
const table = body => '| L | M | R |\n|---|---|---|\n| LEFT | ' + body + ' | RIGHT |';

test('코드·HTML·미완성 펜스의 chart/table 예시는 실제 조회로 치환하지 않는다', () => {
  for (const [lang, resolve, config] of [['chart', resolveChartData, 'data:step1'], ['table', resolveTableData, 'step:1']]) {
    const code = '```' + lang + '\n' + config + '\n```';
    for (const source of [
      code.split('\n').map(s => '    ' + s).join('\n'),
      code.split('\n').map(s => '\t' + s).join('\n'),
      '<div>\n' + code + '\n</div>',
      '<!--\n' + code + '\n-->',
      '````markdown\n' + code + '\n````',
      '- 예시\n\n' + code.split('\n').map(s => '      ' + s).join('\n'),
      '```' + lang + '\n' + config + '\n    ```',
      '```' + lang + '\n' + config,
    ]) for (const newline of ['\n', '\r\n', '\r']) {
      const text = source.replaceAll('\n', newline);
      assert.equal(resolve(text, steps), text);
      // 앞의 원문이 뒤의 독립된 정상 블록까지 가리지 않는다.
      if (!source.startsWith('```' + lang)) {
        const out = resolve(text + '\n\n' + code, steps);
        assert.ok(out.startsWith(text) && out.includes('FOUND_ROW'));
      }
    }
  }
});

test('화면과 공통인 수식 범위 안의 직렬화 chart는 원문이다', () => {
  for (const code of ['`chart<br>data:step1`', '``chart\\ndata:step1``']) {
    for (const source of [
      table('$\\text{' + code + '}$'), table('$$\\text{' + code + '}$$'),
      table('\\(\\unknown{' + code + '}\\)'), table('\\[\\text{' + code + '}\\]'),
      table('\\begin{aligned}x&=\\text{' + code + '}\\end{aligned}'),
      table('[^' + code + ']') + '\n\n[^' + code + ']: 각주 본문',
      '[^' + code + ']: 정의만 있는 각주',
    ]) assert.equal(resolveChartData(source, steps), source);
  }
});

test('표가 아닌 산문의 파이프 사이 코드와 서식 속 코드는 조회 주입 대상이 아니다', () => {
  const code = '`chart\\ntype:bar\\ndata:step1`';
  for (const source of ['설명 | ' + code + ' | 끝', '**' + code + '**',
    '[링크 ' + code + '](https://example.test)', '> 설명 | ' + code + ' | 끝',
    '설명\\n\\n' + code.replace('data:step1', 'title:그림')])
    assert.equal(resolveChartData(source, steps), source);
});

test('개행이 직렬화된 선택적 가장자리 표도 수식·주소의 원문을 유지하며 채운다', () => {
  for (const newline of ['\\n', '\\r\\n']) {
    const code = '`chart\\ntype:bar\\ndata:step1`';
    const source = ['L | M | R', '--- | --- | ---', code + ' | $\\nonsense{x}$ | [주소](https://example.test/\\n)'].join(newline);
    const resolved = resolveChartData(source, steps);
    assert.ok(resolved.includes('FOUND_ROW'));
    assert.ok(resolved.includes('$\\nonsense{x}$'));
    assert.ok(resolved.includes('https://example.test/\\n'));
    assert.ok(resolved.startsWith('L | M | R\n--- | --- | ---\n'));
  }
});
