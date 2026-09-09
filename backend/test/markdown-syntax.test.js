import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChartData, resolveTableData } from '../src/chart.js';
import { answerSyntax } from '../src/markdown-syntax.js';

const steps = [[{ A: 'FOUND_ROW', B: 7 }]];
const table = body => '| L | M | R |\n|---|---|---|\n| LEFT | ' + body + ' | RIGHT |';

test('직렬화된 행 경계를 넘는 링크·이미지·수식은 다음 조회를 소유하지 않는다', () => {
  for (const [open, close] of [['[link', '](https://example.test)'], ['![alt', '](https://example.test)'],
    ['$x^2', '$'], ['$$x^2', '$$'], ['\\(x^2', '\\)'], ['\\[x^2', '\\]']])
    for (const newline of ['\\n', '\\r\\n']) {
      const source = ['> | L | $|h|$ | R |', '> |---|---|---|', '> | OPEN | ' + open + ' | OPEN_END |',
        '> | QUERY | `chart\\ndata:step1` | QUERY_END |', '> | CLOSE | ' + close + ' | CLOSE_END |'].join('\n');
      const syntax = answerSyntax(source.replaceAll('\n', newline), { serialized: true });
      assert.equal(syntax.source, source);
      assert.equal(syntax.tableRows.length, 4);
      assert.equal(resolveChartData(source.replaceAll('\n', newline), steps), resolveChartData(source, steps));
      assert.equal((resolveChartData(source.replaceAll('\n', newline), steps).match(/FOUND_ROW/g) ?? []).length, 1);
    }
});

test('표의 개행 복원은 TeX 제어 단어와 사용자 매크로를 열거 없이 보존한다', () => {
  for (const tex of [String.raw`x\nleqq y\nVdash z`, String.raw`\newcommand{\n}{x}\n`,
    String.raw`\newcommand{\nROW}{x}\nROW`, String.raw`\text{a\n|b}`])
    for (const newline of ['\\n', '\\r\\n']) {
      const source = table('$' + tex + '$');
      assert.equal(answerSyntax(source.replaceAll('\n', newline), { serialized: true }).source, source);
      assert.equal(resolveChartData(source.replaceAll('\n', newline), steps), source.replaceAll('\n', newline));
    }
});

test('수식·시각화 머리글의 표는 원문 좌표로 조회하고 자동 링크는 그대로 둔다', () => {
  const chart = '`chart\\ntitle: HEAD | 원문\\ndata:step1`';
  const url = 'https://example.test/`chart\\ndata:step1`';
  for (const header of ['$|x|$', String.raw`\[a|b\]`, '`mermaid\\nflowchart LR\\nA -->|label| B`', chart])
    for (const newline of ['\n', '\r\n', '\r', '\\n', '\\r\\n']) {
      const source = ['> | L | ' + header + ' | R |', '> |---|---|---|',
        '> | LEFT | ' + chart + ' | RIGHT |', '> | LINK | ' + url + ' | END |'].join(newline);
      const syntax = answerSyntax(source, { serialized: true });
      assert.equal(syntax.tableRows.length, 3, source);
      for (const [start, end] of syntax.tableRows) assert.match(syntax.source.slice(start, end), /^\|.*\|$/);
      const resolved = resolveChartData(source, steps);
      assert.ok(resolved.includes('FOUND_ROW'), source);
      assert.ok(resolved.includes(url), resolved);
      assert.ok(resolved.includes('HEAD \\| 원문'), resolved);
      assert.equal((resolved.match(/FOUND_ROW/g) ?? []).length, header === chart ? 2 : 1);
    }
});

test('자동 링크의 표시문·주소는 명시적 링크의 주소와 같은 리터럴 범위다', () => {
  for (const ticks of ['`', '``', '```']) {
    const url = 'https://example.test/' + ticks + 'chart\\ndata:step1' + ticks;
    for (const link of [url, '<' + url + '>', '[주소](' + url + ')']) {
      assert.equal(resolveChartData(table(link), steps), table(link));
      assert.equal(resolveChartData(link, steps), link);
    }
  }
});

test('표의 미완성 코드가 다음 행의 실제 조회 코드를 리터럴로 가리지 않는다', () => {
  for (const head of ['MIDDLE', '$|x|$']) for (const ticks of ['`', '``', '```']) {
    const code = '`chart\\ndata:step1`';
    const source = '| L | ' + head + ' | R |\n|---|---|---|\n| OPEN | ' + ticks + 'ordinary | END |\n| QUERY | ' + code + ' | RIGHT |';
    const resolved = resolveChartData(source, steps);
    assert.equal((resolved.match(/FOUND_ROW/g) ?? []).length, 1, source);
    assert.ok(resolved.includes(ticks + 'ordinary | END |'), resolved);
  }
});

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
