// 수식 표기 회귀 테스트 — 실행: npm test (frontend/)
// 이 계약은 조용히 깨진다: 수식이 안 그려지면 원문이 그대로 노출되고, 반대로 잘못 그려지면
// 그 사이의 문장이나 표 행이 수식 조판 속으로 사라진다. 둘 다 오류로는 보이지 않는다.
//
// 전부 실제 렌더까지 통과시켜 확인한다 — 판정(math.js)과 remark-math·KaTeX가 그 판정을 어떻게
// 읽는지가 함께 있어야 계약이 성립하기 때문이다.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { compatibleEnvironments } from '../src/tex-environments.js';
import { MATH_CORPUS, MATH_LAYOUT_CASES } from './math-corpus.js';
import { TABLE_FORMULAS, INCOMPLETE_TABLE_FORMULAS } from './table-math-corpus.js';

const render = md => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: REMARK_PLUGINS,
  rehypePlugins: REHYPE_PLUGINS,
}, md));
// 수식 처리를 뺀 markdown 렌더 — '수식이 아닌 자리는 그대로인가'를 이것과 비교해서 본다
const plain = md => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md));

// KaTeX는 원문을 <annotation encoding="application/x-tex"> 에 그대로 실어준다 —
// '무엇이 수식으로 그려졌는가'를 조판 결과가 아니라 이 값으로 본다.
const formulas = md => [...render(md).matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)]
  .map(m => m[1].replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());
// 화면에 실제로 남는 글자 (태그를 걷어낸 본문)
const visible = md => render(md).replace(/<span class="katex-html"[\s\S]*?<\/annotation>/g, '').replace(/<[^>]*>/g, '');
const isDisplay = md => render(md).includes('katex-display');
// href만 뽑는다 — 주소가 한 글자라도 달라지면 링크는 조용히 다른 곳을 가리킨다
const hrefs = md => [...render(md).matchAll(/href="([^"]*)"/g)].map(m => m[1]);

test('표의 절댓값·적분·곡률 수식은 구분자 안 공백과 위치에 상관없이 온전히 보존된다', () => {
  for (const tex of TABLE_FORMULAS) for (const [left, right] of [['', ''], [' ', ''], ['', ' '], [' ', ' '], ['\t', '\t']])
    for (const slash of ['\\', '₩', '￦'])
    for (const position of [0, 1, 2]) for (const border of [false, true]) for (const header of [false, true]) {
      const equation = `$${left}${tex.replaceAll('\\', slash)}${right}$`;
      const cells = ['이웃1', '이웃2', '이웃3']; cells[position] = equation;
      const row = values => (border ? '| ' : '') + values.join(' | ') + (border ? ' |' : '');
      const md = [row(header ? cells : ['열1', '열2', '열3']), row(['---', '---', '---']),
        row(header ? ['값1', '값2', '값3'] : cells)].join('\n');
      assert.deepEqual(formulas(md), [tex], md);
      const html = render(md);
      assert.equal((html.match(/<th>/g) ?? []).length, 3, md);
      assert.equal((html.match(/<td>/g) ?? []).length, 3, md);
      assert.ok(cells.filter(c => c !== equation).every(c => html.includes(c)), md);
      assert.ok(!html.includes('math-error'), md);
    }
});

test('표의 불완전한 수식은 해당 셀에만 격리하고 이웃 셀·다음 행을 보존한다', () => {
  for (const broken of INCOMPLETE_TABLE_FORMULAS) for (const position of [0, 1, 2])
    for (const prefix of ['', '> ', '  ']) for (const border of [false, true]) {
      const row = cells => (border ? '| ' : '') + cells.join(' | ') + (border ? ' |' : '');
      const cells = ['이웃1', '이웃2', '이웃3']; cells[position] = broken;
      const md = [row(['열1', '열2', '열3']), row(['---', '---', '---']), row(cells),
        row(['다음', '$x=1$', '끝'])].map(line => prefix + line).join('\n');
      const html = render(md);
      assert.deepEqual(formulas(md), ['x=1'], md);
      assert.equal((html.match(/<td>/g) ?? []).length, 6, md);
      assert.equal((html.match(/<details/g) ?? []).length, 1, md);
      assert.ok(html.includes('<code>' + broken.replaceAll('&', '&amp;') + '</code>'), md);
      assert.ok(cells.filter(c => c !== broken).every(c => html.includes('<td>' + c + '</td>')), md);
      assert.ok(html.includes('<td>다음</td>') && html.includes('<td>끝</td>'), md);
    }
});

test('표의 오류 수식과 이웃 수식의 구분자가 서로 연결되지 않는다', () => {
  for (const space of ['', ' ']) {
    const md = '| A | B | C |\n|---|---|---|\n' + `| $\\frac{ | $${space}${TABLE_FORMULAS[0]} $ | $ y=2 $ |`;
    assert.deepEqual(formulas(md), [TABLE_FORMULAS[0], 'y=2']);
    assert.equal((render(md).match(/<td>/g) ?? []).length, 3);
    assert.equal((render(md).match(/<details/g) ?? []).length, 1);
  }
  for (const raw of ['| $100 | $200 | $300 |', '| $ORACLE_HOME | \\$x=1 | `$\\frac{` |']) {
    const input = '| A | B | C |\n|---|---|---|\n' + raw;
    assert.equal(render(input), plain(input), raw);
  }
  const table = '| 수식 | 값 |\n|---|---|\n| $ ' + TABLE_FORMULAS[0] + ' $ | 정상 |';
  assert.deepEqual(formulas('금액 $100\n\n' + table), [TABLE_FORMULAS[0]]);
  assert.ok(render('금액 $100\n\n' + table).includes('<p>금액 $100</p>'));
});

test('표의 모든 스트리밍 접두사에서 앞의 완성된 행을 보존한다', () => {
  const first = '| A | B | C |\n|---|---|---|\n| 먼저 | $x=1$ | 유지 |\n';
  const row = '| 이어서 | $ ' + TABLE_FORMULAS[2].replaceAll('\\', '₩') + ' $ | 끝 |';
  for (let i = 0; i <= row.length; i++) {
    const md = first + row.slice(0, i);
    assert.equal(formulas(md)[0], 'x=1', md);
    assert.ok(render(md).includes('<td>유지</td>'), md);
    assert.ok(!render(md).includes('LLMMATHPLACEHOLDER'), md);
  }
  assert.deepEqual(formulas(first + row), ['x=1', TABLE_FORMULAS[2]]);
});

test('수식 문법 × 구분자 × Markdown 위치의 공통 경로를 검증한다', () => {
  const wrappers = [tex => `$${tex}$`, tex => `$$${tex}$$`, tex => `\\(${tex}\\)`, tex => `\\[${tex}\\]`];
  const contexts = [formula => formula, formula => `설명 &amp; ${formula} **끝**`,
    formula => `- 항목 ${formula}`, formula => `> ${formula}`, formula => `### 식 ${formula}`,
    formula => `| 수식 | 값 |\n|---|---|\n| ${formula} | 1 |`];
  for (const tex of MATH_CORPUS) for (const wrap of wrappers) for (const context of contexts) {
    const md = context(wrap(tex));
    const html = render(md);
    assert.deepEqual(formulas(md), [compatibleEnvironments(tex)], md);
    assert.ok(!html.includes('katex-error'), md);
    assert.ok(!html.includes('LLMMATHPLACEHOLDER'), md);
    if (md.startsWith('|')) assert.equal((html.match(/<td>/g) ?? []).length, 2, md);
  }
});

test('수식은 빈 줄·컨테이너·원화 구분자·중복 구분자·분리된 tag에서도 보존된다', () => {
  for (const md of MATH_LAYOUT_CASES) {
    assert.equal(formulas(md).length, 1, md);
    assert.ok(!render(md).includes('katex-error'), md);
  }
  for (const lang of ['math', 'MATH', 'latex', 'LaTeX', 'TeX']) {
    for (const formula of [String.raw`\[ x=1 \]`, '$x=1$', '$$\nx=1\n$$'])
      assert.deepEqual(formulas('```' + lang + '\n' + formula + '\n```'), ['x=1']);
  }
  const raw = '\\begin{gather}\nx\n>0\n\\end{gather}';
  assert.deepEqual(formulas(raw), [raw], '부등호 >를 인용문 접두사로 지우지 않는다');
  assert.deepEqual(formulas('> ' + raw.replaceAll('\n', '\n> ')), [raw]);
  const formula = String.raw`\begin{gather}x=1\end{gather}`;
  assert.deepEqual(formulas('```text\n\\begin{gather}\n```\n\n' + formula), [formula]);
  assert.deepEqual(formulas(String.raw`$E=mc^2$ \tag{1}`), [String.raw`E=mc^2 \tag{1}`]);
});

test('미지원·잘못된 문법은 원문을 보존하는 동일한 오류 표시를 사용한다', () => {
  for (const tex of [String.raw`\unsupportedExample{x}`, String.raw`\frac{1}`,
    String.raw`\begin{notSupported}x=1\end{notSupported}`, String.raw`\def\loop{\loop}\loop`]) {
    const md = `앞 $${tex}$ 뒤 $x=1$`;
    const html = render(md);
    assert.equal((html.match(/<details/g) ?? []).length, 1, tex);
    assert.ok(html.includes('원문 보기') && !html.includes('#cc0000'));
    assert.deepEqual(formulas(md), ['x=1']);
    assert.ok(html.includes('앞') && html.includes('뒤'));
  }
  // 정규화된 호환 문법 대신 사용자가 받은 원문을 보여준다.
  assert.ok(render('₩[ ₩notSupported{x} ₩]').includes('₩notSupported{x}'));
  assert.deepEqual(formulas(String.raw`$\def\local{x}\local$ $\local$`), [String.raw`\def\local{x}\local`]);
  const good = String.raw`\begin{gather}y=2\end{gather}`;
  for (const bad of [String.raw`$\begin{gather}x$`, String.raw`$\text{\begin{gather}}$`]) {
    assert.deepEqual(formulas(`${bad} 뒤 ${good}`), [good], '앞 수식의 미완성 환경이 뒤 수식을 숨기지 않는다');
  }
});

test('스트리밍의 모든 접두사에서 예외·임시 토큰 누출 없이 최종 수식을 복원한다', () => {
  for (const md of MATH_LAYOUT_CASES.slice(0, 3).concat(String.raw`앞 $\ce{H2O}$ 뒤`, String.raw`\begin{split}x&=1\\y&=2\end{split}`)) {
    for (let n = 0; n <= md.length; n++) {
      const html = render(md.slice(0, n));
      assert.ok(!html.includes('LLMMATHPLACEHOLDER'), md.slice(0, n));
    }
    assert.equal(formulas(md).length, 1);
  }
});

test('여러 줄 환경과 철자 변형을 구분자 유무·인라인 모드에 관계없이 렌더링한다', () => {
  for (const name of ['gather', 'split', 'multline', 'multline*', 'multiline', 'multiline*',
    'subequations', 'subequation', 'flalign', 'flalign*']) {
    const body = ['split', 'flalign', 'flalign*'].includes(name) ? String.raw`x &= 1 \\ y &= 2` : String.raw`x = 1 \\ y = 2`;
    const eq = `\\begin{${name}}${body}\\end{${name}}`;
    for (const slash of ['\\', '₩', '￦']) {
      const input = eq.replaceAll('\\', slash);
      for (const md of [input, `$${input}$`, `$$${input}$$`, `$$\n${input}\n$$`,
        `\\[${input}\\]`, `설명 $${input}$ 끝`, `설명 ${input} 끝`, '```latex\n' + input + '\n```']) {
        const html = render(md);
        assert.ok(isDisplay(md) && !/katex-error|#cc0000/.test(html), md);
        const actual = formulas(md);
        assert.equal(actual.length, 1, md);
        assert.ok(actual[0].includes(body), md);
        assert.ok(!/flalign|multline|multiline|subequation/.test(actual[0]), md);
        if (md.startsWith('설명')) assert.ok(visible(md).includes('설명') && visible(md).includes('끝'), md);
      }
    }
  }
});

test('설명과 같은 문단의 환경을 분리해도 강조·링크·인라인 수식과 환경의 중첩은 유지한다', () => {
  const eq = '\\begin{gather}\nx_1 = 1 \\\\\nx_2 = 2\n\\end{gather}';
  const md = `**설명** $a$\n${eq}\n[참고](https://example.test) $b$ 끝`;
  assert.deepEqual(formulas(md), ['a', eq, 'b']);
  assert.match(render(md), /<strong>설명<\/strong>/);
  assert.deepEqual(hrefs(md), ['https://example.test']);
  assert.ok(visible(md).includes('끝'));
  for (const input of [eq, '> ' + eq.replaceAll('\n', '\n> '), '- ' + eq.replaceAll('\n', '\n  ')])
    assert.deepEqual(formulas(input), [eq], input);
  const nested = String.raw`\begin{equation}\begin{split}x&=1\\&=2\end{split}\tag{A}\end{equation}`;
  assert.deepEqual(formulas(`설명 ${nested} 끝`), [nested]);
  assert.deepEqual(formulas(String.raw`\begin { gather } x=1 \end { gather }`), [String.raw`\begin{gather} x=1 \end{gather}`]);
  assert.deepEqual(formulas(`${eq}\n${eq}`), [eq, eq]);
  assert.deepEqual(formulas(`진행률 100% ${eq} 끝`), [eq]);
  const commented = '\\begin{gather}x=1 % \\end{gather}\n\\\\ y=2\\end{gather}';
  assert.deepEqual(formulas(commented), [commented], '주석 안의 end는 환경을 닫지 않는다');
});

test('subequations 안의 개별 식·명시적 번호와 multline의 단일 번호를 보존한다', () => {
  const eq = String.raw`\begin{subequations}\begin{equation}x=1\tag{1a}\end{equation}\begin{equation}y=2\tag{1b}\end{equation}\end{subequations}`;
  const html = render(eq);
  assert.ok(!/katex-error|#cc0000/.test(html));
  assert.deepEqual(formulas(eq), [String.raw`\begin{align*}\begin{equation}x=1\tag{1a}\end{equation}\\` + '\n' + String.raw`\begin{equation}y=2\tag{1b}\end{equation}\end{align*}`]);
  assert.match(visible(eq), /1a/);
  assert.match(visible(eq), /1b/);
  const multline = String.raw`\begin{multline}x+y\\=3\tag{A}\end{multline}`;
  assert.ok(!/katex-error|#cc0000/.test(render(multline)));
  assert.equal((render(multline).match(/class="tag"/g) ?? []).length, 1);
});

test('환경의 이름만 쓴 설명·코드·링크·닫히지 않은 환경은 바꾸지 않는다', () => {
  for (const md of [String.raw`{gather} {split} {multiline} {subequation} {flalign}`,
    String.raw`\begin{split}x&=1`, String.raw`\begin{gather}x=1\end{split}`,
    String.raw`\begin{gather}\begin{split}x&=1\end{gather}\end{split}`,
    String.raw`\begin{gather}x=1 \\end{gather}`, String.raw`\\begin{gather}x=1\\end{gather}`,
    '`\\begin{split}x&=1\\end{split}`', '```text\n\\begin{multline}x=1\\end{multline}\n```',
    String.raw`[\begin{gather}x=1\end{gather}](https://example.test)`]) assert.equal(render(md), plain(md), md);
});

test('mhchem 화학식·반응식·단위를 수식 구분자와 코드펜스에서 렌더링한다', () => {
  for (const eq of [String.raw`\ce{H2O}`, String.raw`\ce{2H2 + O2 -> 2H2O}`,
    String.raw`\ce{SO4^2-}`, String.raw`\ce{^{14}_{6}C}`, String.raw`\pu{123 kJ mol-1}`]) {
    for (const slash of ['\\', '₩', '￦']) {
      const input = eq.replaceAll('\\', slash);
      for (const md of [input, `$${input}$`, `$$${input}$$`, `$$\n${input}\n$$`,
        `물질 \\(${input}\\) 입니다`, `\\[${input}\\]`, '> ' + input,
        ...['math', 'latex', 'tex'].map(lang => '```' + lang + '\n' + input + '\n```')]) {
        assert.deepEqual(formulas(md), [eq], md);
        assert.ok(!/katex-error|#cc0000/.test(render(md)), md);
      }
    }
  }
  // 원문 주석만 생기는 것이 아니라 아래첨자와 반응 화살표가 실제 MathML에 생겨야 한다.
  assert.match(render(String.raw`$\ce{H2O}$`), /<msub>/);
  assert.match(render(String.raw`$\ce{H2 -> 2H}$`), /→/);
  assert.ok(!isDisplay(String.raw`물 $\ce{H2O}$ 입니다`));
  assert.ok(isDisplay(String.raw`\ce{H2O}`));
});

test('화학식 원문 예시·미완성 명령·명령 설명은 글자로 남는다', () => {
  for (const md of [String.raw`\ce`, String.raw`\ce{H2O`, String.raw`\ce{^{14}C`,
    String.raw`\\ce{H2O}`, String.raw`\ce{}`, '₩100',
    '`\\ce{H2O}`', '```text\n\\ce{H2O}\n```', '```\n\\ce{H2O}\n```',
    '    \\ce{H2O}', '[\\ce{H2O}](https://example.test)']) assert.equal(render(md), plain(md), md);
});

test('KaTeX가 지원하지 않는 flalign은 행·정렬점·번호를 보존한 align으로 그린다', () => {
  for (const star of ['', '*']) {
    const eq = String.raw`\begin{flalign${star}} &x + y = 1 && \\ &2x - y = 3 \tag{A} && \end{flalign${star}}`;
    const expected = eq.replaceAll(`{flalign${star}}`, `{align${star}}`);
    for (const slash of ['\\', '₩', '￦']) {
      const input = eq.replaceAll('\\', slash);
      for (const md of [input, `$${input}$`, `$$${input}$$`, `$$\n${input}\n$$`,
        `\\[${input}\\]`, `앞 \\(${input}\\) 뒤`, '> ' + input,
        ...['math', 'latex', 'tex'].map(lang => '```' + lang + '\n' + input + '\n```')]) {
        assert.deepEqual(formulas(md), [expected], md);
        assert.ok(isDisplay(md) && !render(md).includes('katex-error'), md);
      }
      for (const md of ['`' + input + '`', '```text\n' + input + '\n```',
        '```\n' + input + '\n```', '    ' + input]) assert.equal(render(md), plain(md), md);
    }
  }
  const reported = '₩begin{flalign} &x + y = 1 && ₩₩ &2x - y = 3 && ₩end{flalign}';
  assert.deepEqual(formulas(reported), [String.raw`\begin{align} &x + y = 1 && \\ &2x - y = 3 && \end{align}`]);
  for (const md of [String.raw`\begin{flalign} x=1`, String.raw`\begin{flalign} x=1 \end{align}`])
    assert.equal(render(md), plain(md), md);
});

test('gather와 번호 달린 식은 구분자 누락·인라인 표기에서도 별행으로 복구한다', () => {
  const equations = [
    String.raw`\begin{gather} x + y = 10 \\ x - y = 4 \end{gather}`,
    String.raw`E = mc^2 \tag{1}`,
    String.raw`\begin{align*} x_1 &= 10 \\ x_2 &= 4 \end{align*}`,
    String.raw`\begin{equation} E = mc^2 \tag{1} \end{equation}`,
  ];
  for (const eq of equations) {
    for (const md of [eq, `$${eq}$`, `$$${eq}$$`, `앞 $${eq}$ 뒤`, `앞 $$${eq}$$ 뒤`, `앞 \\(${eq}\\) 뒤`, `앞 \\[${eq}\\] 뒤`]) {
      assert.deepEqual(formulas(md), [eq], md);
      assert.ok(isDisplay(md), md);
      assert.ok(!render(md).includes('katex-error'), md);
      if (md.startsWith('앞')) assert.ok(visible(md).includes('앞') && visible(md).includes('뒤'), md);
    }
  }
});

test('실제 원화 문자는 수식의 명령·줄바꿈에서만 백슬래시로 복구한다', () => {
  for (const eq of [String.raw`\begin{gather} x + y = 10 \\ x - y = 4 \end{gather}`, String.raw`E = mc^2 \tag{1}`]) {
    for (const won of ['₩', '￦']) {
      const broken = eq.replaceAll('\\', won);
      for (const md of [broken, `$${broken}$`, `$$\n${broken}\n$$`, '```latex\n' + broken + '\n```']) {
        assert.deepEqual(formulas(md), [eq], md);
        assert.ok(isDisplay(md) && !render(md).includes('katex-error'), md);
      }
    }
  }
});

test('구분자 없는 여러 줄 환경은 Markdown이 해석하기 전 첨자·줄바꿈을 보존한다', () => {
  const eq = '\\begin{gather}\nx_1 + y_1 = 10 \\\\\nx_2 - y_2 = 4\n\\end{gather}';
  for (const md of [eq, '> ' + eq.replaceAll('\n', '\n> '), '- ' + eq.replaceAll('\n', '\n  ')]) {
    assert.deepEqual(formulas(md), [eq], md);
    assert.ok(isDisplay(md) && !render(md).includes('katex-error'), md);
  }
});

test('구분자 없는 수식 복구가 코드·금액·설명·미완성 환경을 바꾸지 않는다', () => {
  const eq = String.raw`\begin{gather} x=1 \\ y=2 \end{gather}`;
  for (const md of [
    '`' + eq + '`', '```text\n' + eq + '\n```', '    ' + eq,
    '₩100, ￦200, ₩begin 사용법', String.raw`설명: E = mc^2 \tag{1}`,
    String.raw`The equation E = mc^2 \tag{1}`, String.raw`\tag{1}은 식 번호입니다.`,
    String.raw`\begin{gather} x=1`, String.raw`\begin{gather} x=1 \end{align}`,
    String.raw`E = mc^2 \\tag{1}`, String.raw`\begin{gather} x=1 \\end{gather}`,
    '[' + eq + '](https://example.test)',
  ]) assert.equal(render(md), plain(md), md);
});

test('이스케이프된 대괄호는 별행 수식의 구분자가 되지 않는다', () => {
  for (const md of [String.raw`\[ x = 1 \\]`, String.raw`\\[ x = 1 \]`, String.raw`\\[ x = 1 \\]`]) {
    assert.equal(render(md), plain(md), md);
    assert.equal(render(`> ${md}`), plain(`> ${md}`), `인용문: ${md}`);
  }
});

test('별행 수식의 닫는 줄은 따로 있어야 하며 여는 달러 수 이상이어야 한다', () => {
  for (const md of ['$$', '$$\nx=1\n\n이어지는 문장$$', '$$$\nx=1\n$$', '$$\n> $$']) {
    const html = render(md);
    assert.ok(!html.includes('katex'), html);
    assert.equal(html.replace(/<[^>]*>/g, ''), md.replace(/>/g, '&gt;'), md);
  }
  assert.deepEqual(formulas('$$$\nx=1\n$$$$'), ['x=1']);
  assert.deepEqual(formulas('> $$$\n> x=1\n> $$$'), ['x=1']);
  assert.deepEqual(formulas('- 항목\n\n  $$$\n  x=1\n  $$$'), ['x=1']);
});

test('$ 하나로 감싼 수식을 그린다 — 표 셀 안에서도', () => {
  assert.deepStrictEqual(formulas('속도는 $v = d/t$ 이다.'), ['v = d/t']);
  assert.deepStrictEqual(formulas('| 항목 | 값 |\n|---|---|\n| 속도 | $v = d/t$ |'), ['v = d/t']);
  // 한글 조사가 바로 붙는 것이 이 앱의 보통 문장이다
  assert.deepStrictEqual(formulas('$E=mc^2$는 유명하다'), ['E=mc^2']);
  assert.deepStrictEqual(formulas('$a$ 와 $b$'), ['a', 'b']);
  // 제목·목록·인용문 안에서도 (markdown이 이미 갈라 준 자리라 따로 다룰 것이 없다)
  assert.deepStrictEqual(formulas('### 속도 $v=d/t$'), ['v=d/t']);
  assert.deepStrictEqual(formulas('- 속도 $v=d/t$\n- 면적 $a b$'), ['v=d/t', 'a b']);
  assert.deepStrictEqual(formulas('> 속도 $v=d/t$ 이다'), ['v=d/t']);
});

test('금액의 $는 수식이 아니다', () => {
  // 이걸 놓치면 '$100 이고 수익은 $200'의 가운데가 통째로 수식이 되어 문장이 사라진다
  for (const md of ['비용은 $100 이고 수익은 $200 이다', '가격: $5, 세금: $1', '$100~$200']) {
    assert.deepStrictEqual(formulas(md), [], md);
    assert.ok(visible(md).includes('$'), md);
  }
  // 표는 이 앱의 본업이다 — 행이 통째로 먹히면 안 된다
  const table = '| 항목 | 금액 |\n|---|---|\n| 배송 | $100 |\n| 상품 | $200 |';
  assert.deepStrictEqual(formulas(table), []);
  assert.ok(render(table).includes('<td>$100</td>') && render(table).includes('<td>$200</td>'));
  // 물린 후보 뒤에 오는 진짜 수식은 살아남아야 한다
  assert.deepStrictEqual(formulas('비용 $100 과 수익 $200 이고 속도는 $v=d/t$ 이다'), ['v=d/t']);
});

test('환경변수·경로의 $는 수식이 아니다', () => {
  assert.deepStrictEqual(formulas('$HOME/$PATH 를 확인하라'), []);
  assert.deepStrictEqual(formulas('$ORACLE_HOME 확인'), []);
  assert.deepStrictEqual(formulas('식별자 A$B$C'), []);
});

test('$$ 구분자는 문장 안에서도 일관되게 별행 수식으로 동작한다', () => {
  assert.deepStrictEqual(formulas('계산식은 $$E = mc^2$$ 이다.'), ['E = mc^2']);
  assert.ok(isDisplay('계산식은 $$E = mc^2$$ 이다.'));
  // 한 줄로 쓴 $$…$$가 문단을 혼자 차지하면 별행이다. remark-math는 이것을 인라인으로 보지만
  // (별행은 $$가 제 줄에 홀로 설 때뿐이다) 모델은 별행 수식을 거의 언제나 이렇게 쓴다 —
  // 인라인으로 두면 넓은 수식이 말풍선에 잘려 오른쪽을 볼 방법이 없다.
  assert.ok(isDisplay('$$E = mc^2$$'), '한 줄 $$…$$가 문단을 혼자 차지하면 별행으로');
  assert.deepStrictEqual(formulas('$$E = mc^2$$'), ['E = mc^2']);
  assert.ok(isDisplay('계산식:\n\n$$E = mc^2$$\n'), '앞 문단이 있어도 마찬가지');
  assert.ok(!isDisplay('$v = d/t$'), '홑 $ 한 줄은 문장 속 표기 그대로 인라인');
  assert.ok(isDisplay('- 항목\n\n  $$E = mc^2$$'), '목록 안 단독 줄에서도');
  assert.deepStrictEqual(formulas('계산식:\n\n$$\nE = mc^2\n$$\n'), ['E = mc^2']);
  assert.ok(isDisplay('계산식:\n\n$$\nE = mc^2\n$$\n'));
  // 인용문·목록 안의 별행 수식 (줄마다 붙는 '>'가 수식 안으로 들어가면 안 된다)
  assert.deepStrictEqual(formulas('> $$\n> E = mc^2\n> $$\n'), ['E = mc^2']);
  assert.deepStrictEqual(formulas('- 항목\n\n  $$\n  E = mc^2\n  $$\n'), ['E = mc^2']);
  // CRLF 답변에서도 같다
  assert.deepStrictEqual(formulas('$$\r\nE = mc^2\r\n$$\r\n'), ['E = mc^2']);
});

test('\\( \\) 와 \\[ \\] 표기도 그린다', () => {
  // markdown이 백슬래시를 먼저 떼기 때문에 원문(position)을 보지 않으면 '( )'·'[ ]'만 남는다
  assert.deepStrictEqual(formulas('속도는 \\( v = d/t \\) 이다'), ['v = d/t']);
  assert.deepStrictEqual(formulas('\\[ E = mc^2 \\]'), ['E = mc^2']);
  assert.ok(isDisplay('\\[ E = mc^2 \\]'), '문단을 혼자 차지하면 별행으로');
  assert.ok(isDisplay('식 \\[ E = mc^2 \\] 이다'), '명시한 별행 구분자는 문장 안에서도 별행으로');
  assert.deepStrictEqual(formulas('- 항목: \\( x^2 \\)'), ['x^2'], '목록 안에서도');
  assert.deepStrictEqual(formulas('> \\[ E = mc^2 \\]'), ['E = mc^2'], '인용문 안에서도');
  assert.deepStrictEqual(formulas('- 항목\n\n  \\[ E = mc^2 \\]'), ['E = mc^2'], '목록 안 단독 줄');
  // 여러 줄에 걸친 별행 수식
  assert.deepStrictEqual(formulas('\\[\n\\begin{aligned}\nx &= 1\n\\end{aligned}\n\\]'), ['\\begin{aligned}\nx &= 1\n\\end{aligned}']);
});

test('닫히지 않은 $$가 남은 답변을 통째로 삼키지 않는다', () => {
  const md = '$$\nE = mc^2\n\n이어지는 설명 문단이다.';
  assert.deepStrictEqual(formulas(md), []);
  assert.ok(visible(md).includes('이어지는 설명 문단이다.'));
  // 여는 줄에 이어 쓰다 끊긴 것도 글자로 남아야 한다. remark-math는 '$$' 뒤의 나머지를 코드펜스의
  // 언어처럼 meta에 담으므로, 되돌릴 때 그것을 빠뜨리면 수식이 통째로 사라지고 '$$'만 남는다 —
  // 토큰 한도로 잘린 답변에서 가장 흔한 모양이다.
  const cut = '평균은 다음과 같습니다.\n\n$$ \\bar{x} = \\frac{1}{n}\\sum x_i';
  assert.deepStrictEqual(formulas(cut), []);
  assert.ok(visible(cut).includes('\\bar{x}'), visible(cut));
  assert.ok(visible(cut).includes('\\sum x_i'), visible(cut));
  const tail = '$$ \\alpha + \\beta\n\n이어지는 설명이다.';
  assert.ok(visible(tail).includes('\\alpha + \\beta') && visible(tail).includes('이어지는 설명이다.'), visible(tail));
});

test('별행 수식은 여는 줄에 이어 써도, 빈 줄 없이 잇달아 써도 온전히 그려진다', () => {
  // remark-math는 '$$' 뒤에 이어 쓴 글자를 코드펜스의 언어처럼 meta에 담는다 — 그것을 빠뜨리면
  // 닫힌 블록에서도 수식이 빈 조판 블록이 되어 화면에서 통째로 사라진다.
  assert.deepStrictEqual(formulas('평균:\n\n$$ \\bar{x} = 1\n$$'), ['\\bar{x} = 1']);
  assert.deepStrictEqual(formulas('$$ \\alpha\n\\beta\n$$'), ['\\alpha\n\\beta']);
  assert.deepStrictEqual(formulas('$$\nx = 1\n$$'), ['x = 1']);
  // 유도 과정은 빈 줄 없이 줄바꿈만으로 잇대어 온다 — 그 둘 다 별행이어야 가운데 정렬과 가로 스크롤을 얻는다
  const two = '$$a = 1$$\n$$b = 2$$';
  assert.deepStrictEqual(formulas(two), ['a = 1', 'b = 2']);
  assert.strictEqual((render(two).match(/katex-display/g) ?? []).length, 2);
  const brackets = '\\[ a=1 \\]\n\\[ b=2 \\]';
  assert.deepStrictEqual(formulas(brackets), ['a=1', 'b=2']);
  assert.strictEqual((render(brackets).match(/katex-display/g) ?? []).length, 2);
  // 별행 구분자의 의미가 주변 문장 유무에 따라 바뀌지 않는다.
  assert.ok(isDisplay('앞 $$a = 1$$ 뒤'));
  assert.deepStrictEqual(formulas('앞 $$a = 1$$ 뒤'), ['a = 1']);
});

test('코드 안의 $와 \\(는 글자 그대로 남는다', () => {
  const fenced = '```bash\necho $HOME\n```';
  assert.deepStrictEqual(formulas(fenced), []);
  assert.ok(render(fenced).includes('echo $HOME'));
  const span = '변수 `$v = d/t$` 를 쓴다';
  assert.deepStrictEqual(formulas(span), []);
  assert.ok(render(span).includes('<code>$v = d/t$</code>'));
  assert.deepStrictEqual(formulas('```\n\\( x \\)\n```'), []);
  // 4칸 들여쓴 코드블록도 markdown이 이미 코드로 갈라 준다
  assert.deepStrictEqual(formulas('    $x$ 는 코드블록 안이다'), []);
  // 이스케이프한 $는 사용자가 '$를 보이겠다'고 쓴 것이다
  assert.deepStrictEqual(formulas('\\$100 과 \\$200'), []);
  // ```math 펜스는 rehype-katex가 직접 그린다
  assert.deepStrictEqual(formulas('```math\nE = mc^2\n```'), ['E = mc^2']);
});

test('주소 안의 $는 수식으로 보지 않는다', () => {
  // $$로 바뀌면 링크가 엉뚱한 곳을 가리킨다 — 화면에는 멀쩡한 링크로 보이므로 눈에 띄지 않는다
  assert.deepStrictEqual(hrefs('[가이드](http://intranet/wiki/batch$job$/restart) 참고'), ['http://intranet/wiki/batch$job$/restart']);
  assert.deepStrictEqual(hrefs('대시보드: https://ops.local/d/$svc$/overview 확인'), ['https://ops.local/d/$svc$/overview']);
  assert.deepStrictEqual(hrefs('<https://ops.local/job/$name$/console>'), ['https://ops.local/job/$name$/console']);
  assert.deepStrictEqual(formulas('![차트](http://x/$id$.png "월별 $추이$")'), []);
  // 맨 URL은 링크의 '글자'가 곧 주소다 — 그 안에서 수식을 만들면 화면에 보이는 주소가 달라진다
  assert.deepStrictEqual(formulas('https://ops.local/d/$svc$/overview 확인'), []);
  assert.ok(visible('https://ops.local/d/$svc$/overview 확인').includes('/d/$svc$/overview'));
  // 반대로 대괄호로 직접 쓴 링크의 '글자'는 주소와 별개다 — 그 안의 수식은 그린다
  assert.deepStrictEqual(formulas('[속도 $v=d/t$ 문서](http://x/a)'), ['v=d/t']);
});

test('한글만 든 홑 $ 구간은 수식으로 보지 않는다', () => {
  // TeX에는 한글 조판이 없다 — 기호도 명령도 없이 한글만 든 구간은 수식이었을 리가 없다
  assert.deepStrictEqual(formulas('항목 $가,$나 순서'), []);
  assert.deepStrictEqual(formulas('$금액$ 확인'), []);
  // 기호나 명령이 함께 있으면 그대로 수식이다
  assert.deepStrictEqual(formulas('속도 $속도 = 거리/시간$ 이다'), ['속도 = 거리/시간']);
  assert.deepStrictEqual(formulas('$\\text{합계} = 100$'), ['\\text{합계} = 100']);
  // $$로 명시한 구간에는 걸지 않는다
  assert.deepStrictEqual(formulas('$$면적$$'), ['면적']);
});

test('수식 안의 markdown 기호가 조판을 깨지 않는다', () => {
  assert.deepStrictEqual(formulas('$x_1 + y_2$'), ['x_1 + y_2']);
  assert.deepStrictEqual(formulas('$$a_i + b_i$$'), ['a_i + b_i']);
});

test('수식이 없는 답변은 markdown 그대로 렌더된다', () => {
  // 수식 판정이 본문을 건드리면 안 된다 — 표·코드·링크·금액이 든 실제 답변 모양으로 확인한다
  const answers = [
    '### 배치 상태\n\n| 작업 | 상태 |\n|---|---|\n| BATCH001 | FAILED |',
    '재시작: `restart.sh BATCH001`\n\n1. 접속\n2. 실행\n3. 확인',
    '```bash\nexport ORACLE_HOME=/opt/oracle\necho $ORACLE_HOME\n```',
    '비용은 $100, 세금은 $10, 합계는 $110 입니다.',
    '경로는 C:\\Users\\admin\\batch 이고 로그는 D:\\logs\\app.log 입니다.',
    '자세한 내용은 [운영 가이드](http://intranet/wiki/ops)와 https://ops.local/status 참고.',
    '> 참고: 100% 완료\n\n---\n\n**주의** 및 *강조*, ~~취소선~~',
    '- [ ] 할 일 A\n- [x] 완료 B\n\n각주[^1]\n\n[^1]: 설명입니다.',
    '조회에 실패했습니다. 관리자에게 문의하세요.',
    '엔티티 &amp; 와 &lt;태그&gt; 그리고 $100',
  ];
  for (const md of answers) assert.equal(render(md), plain(md), md);
});

test('KaTeX가 말풍선을 뚫는 크기를 만들지 못한다', () => {
  // \rule 하나가 7000px짜리 막대가 되면 대화 전체가 화면 밖으로 밀린다 (maxSize)
  const html = render('$$\\rule{1em}{500em}$$');
  assert.ok(!/height:\s*500em/.test(html), html.slice(0, 200));
  assert.ok(/height:\s*10em/.test(html));
});

test('문법이 틀린 수식이 답변 전체를 날리지 않는다', () => {
  // 모델이 만든 수식은 언제든 틀릴 수 있다 — 그 하나 때문에 답변이 통째로 사라지면 안 된다
  const md = '앞 문장 $$\\frac{1}$$ 뒷 문장';
  const html = render(md);
  assert.ok(html.includes('앞 문장') && html.includes('뒷 문장'));
  assert.ok(html.includes('katex-error'));
  // 지원하지 않는 명령도 같은 오류 경로로 보내고, 정확한 원문은 펼쳐 볼 수 있게 남긴다.
  const unknown = render('$$\\foobarbazqux{1}$$');
  assert.ok(unknown.includes('<details') && unknown.includes('원문 보기'));
  assert.ok(!unknown.includes('#cc0000') && unknown.includes('\\foobarbazqux{1}'));
});

test('긴 입력에도 선형으로 동작한다', () => {
  // 짝을 못 찾는 기호가 반복되는 퇴화 입력에서 이차가 되면 렌더가 프레임을 통째로 잡아먹는다
  for (const unit of ['$', '$$', '\\( ', '\\[ ', '`', '$$x\n', '$100 ']) {
    const t0 = performance.now();
    render((unit + 'x ').repeat(3000));
    assert.ok(performance.now() - t0 < 3000, unit);
  }
});

test('이스케이프된 표시(\\$, \\\\( )는 수식의 여닫는 표시가 아니다', () => {
  // markdown에서 `\$`는 글자 $이다 — 모델이 금액을 수식으로 읽힐까 봐 그렇게 적는다. 그것을 여닫는
  // 표시로 읽으면 글자 $가 사라지고 끝에 남은 백슬래시가 조판 오류로 붉게 선다(화면 재현으로 확인:
  // '가격은 \$5이고 이익은 \$.'가 '가격은 \5이고 이익은 \.'로 나왔다).
  for (const md of ['\\$a\\$', '가격은 \\$5이고 이익은 \\$.', '비용 \\$5 (최소) ~ \\$ 단위']) {
    assert.deepStrictEqual(formulas(md), [], md);
    assert.strictEqual(visible(md), plain(md).replace(/<[^>]*>/g, ""), md); // 수식 처리를 뺀 렌더와 글자가 같다
    assert.ok(!render(md).includes('katex-error'), `${md}: 조판 오류가 남았다`);
  }
  // `\\(`는 백슬래시 하나 뒤의 여는 괄호다 — 표시가 아니다
  assert.deepStrictEqual(formulas('\\\\(x\\\\)'), []);
  assert.strictEqual(visible('\\\\(x\\\\)'), '\\(x\\)');
  // 이스케이프된 백슬래시 뒤의 진짜 표시는 그대로 수식이다 — 백슬래시가 짝수 개면 표시가 살아 있다
  assert.deepStrictEqual(formulas('\\\\$x$ 뒤'), ['x']);
  assert.deepStrictEqual(formulas('\\\\\\(x\\\\\\)'), ['x\\\\']);
  assert.deepStrictEqual(formulas('$a\\$b$'), ['a\\$b'], '수식 안의 이스케이프된 달러는 구분자가 아니다');
});

test('수식 코드펜스는 ```math·```latex·```tex 셋 다 별행 수식으로 그린다', () => {
  // 모델이 수식을 코드펜스에 넣는 일이 잦다. ```latex 만 코드블록으로 남던 때, 'latex 어려운 수식 10개'
  // 요청의 답이 통째로 원문으로 화면에 나왔다(실측). 코드블록은 '글자 그대로'라는 표기라 화면 잘못이 아니었다.
  const EQ = '\\begin{aligned}\n\\mathcal{L}\\{f(t)\\}(s) &= \\int_{0}^{\\infty} e^{-st}f(t)\\,dt \\\\\n\\end{aligned}';
  for (const lang of ['math', 'latex', 'tex']) {
    const md = '```' + lang + '\n' + EQ + '\n```';
    assert.deepStrictEqual(formulas(md), [EQ], `\`\`\`${lang} 이 수식으로 그려지지 않았다`);
    assert.ok(isDisplay(md), `\`\`\`${lang} 이 별행으로 그려지지 않았다`);
    // 코드블록으로 남지 않아야 한다 — rehype-katex는 pre째로 바꾼다 (원문은 KaTeX가 MathML 주석에 싣는다)
    assert.ok(!render(md).includes('<code'), `\`\`\`${lang} 이 코드블록으로 남았다`);
  }
});

test('수식이 아닌 코드펜스는 그대로 코드로 남는다', () => {
  // 사용자가 원문을 보여 달라고 하면 모델은 ```text 를 쓴다 (시스템 프롬프트) — 그 길이 막히면 안 된다.
  for (const lang of ['text', 'js', 'sql', 'json']) {
    const md = '```' + lang + '\n\\frac{a}{b}\n```';
    assert.deepStrictEqual(formulas(md), [], `\`\`\`${lang} 이 수식으로 그려졌다`);
    assert.ok(render(md).includes('<code'), `\`\`\`${lang} 이 코드블록으로 남지 않았다`);
    assert.ok(visible(md).includes('\\frac{a}{b}'), `\`\`\`${lang} 의 원문이 화면에서 사라졌다`);
  }
  // 언어를 적지 않은 펜스도 코드다
  assert.deepStrictEqual(formulas('```\n\\frac{a}{b}\n```'), []);
});

test('여러 줄로 이어 쓴 목록 항목·인용문 안의 수식도 그려진다 — 파서가 줄 사이에서 뗀 표시가 원문에는 남아 있다', () => {
  // 원문 조각을 통째로 파서의 값과 비교하던 동안에는 두 줄 넘게 이어 쓴 목록 항목·인용문의 수식이 하나도 그려지지
  // 않았다(실측) — 한 줄로 쓰면 그려지는 같은 글이다. 걸린 것은 셋: 컨테이너 표시(>·들여쓰기), 소프트 줄바꿈 앞뒤의
  // 공백, 그 둘이 CRLF와 섞인 것. 파서는 그것들을 값에서 뗐고 원문 조각에는 남아 있었다(math.js alignedRaw).
  assert.deepStrictEqual(formulas('- 항목 $x$ 는\n  이어서 $y$'), ['x', 'y']);
  assert.deepStrictEqual(formulas('1. 항목 \\(x\\) 는\n   이어서 \\(y\\)'), ['x', 'y']);
  assert.deepStrictEqual(formulas('- 밖\n  - 안 $x$ 는\n    이어서 $y$'), ['x', 'y']);
  assert.deepStrictEqual(formulas('> 첫 줄 $x$\n> 둘째 줄 $y$'), ['x', 'y']);
  assert.deepStrictEqual(formulas('앞 줄 $a$ \n뒤 줄 $b$'), ['a', 'b']);
  assert.deepStrictEqual(formulas('앞 줄 $a$ \r\n  뒤 줄 $b$'), ['a', 'b']);
  assert.deepStrictEqual(formulas('> 값은 $a +\n> b$ 이다'), ['a +\nb'], '줄을 넘는 수식 안에 인용문 표시가 남지 않는다');
  // 화면 글자에 인용문 표시가 새어 나오지 않는다
  assert.ok(!/&gt;|>/.test(visible('> 첫 줄 $x$\n> 둘째 줄 $y$')));
  // 이웃 노드와의 경계 공백은 값에도 있다 — 그것까지 걷어내면 그 노드가 통째로 '다르다'로 걸려 그려지지 않는다
  assert.deepStrictEqual(formulas('*강조* 뒤 $x$ 와 $y$ *다시*'), ['x', 'y']);
  // 인용문 안에서 수식만 있는 문단은 별행이다
  assert.ok(isDisplay('> \\[a\\]\n> \\[b\\]'));
  assert.deepStrictEqual(formulas('> \\[a\\]\n> \\[b\\]'), ['a', 'b']);
  // 엔티티가 같은 문장에 있어도 수식은 원문에서 분리하고, 엔티티는 Markdown이 해독한다.
  assert.deepStrictEqual(formulas('&amp; 와 $x$'), ['x']);
});

// 닫히지 않은 \(·\[가 되풀이되는 퇴화한 답변에서 비탐욕 매치는 '여는 표시 수 × 길이'였다(실측: 답변 상한 안의 '\( x '
// 되풀이가 319ms, 길이 두 배에 네 배). 미리보기는 120ms마다 자라난 전체를 다시 그리므로 그 비용이 스트림 끝까지 쌓인다.
test('닫히지 않은 \\(·\\[가 아무리 많아도 렌더 비용이 길이에 비례한다 — 한 덩어리의 길이를 묶어서', () => {
  for (const unit of ['\\( x ', '\\[ x ']) {
    const ms = n => { const t0 = performance.now(); render(unit.repeat(n)); return performance.now() - t0; };
    ms(1000);
    // 한 번의 GC가 큰 입력 측정에만 끼면 선형 구현도 10배 이상으로 보인다.
    // 두 크기를 번갈아 측정한 중앙값으로 같은 8배 상한을 검사한다.
    const small = [], large = [];
    for (let i = 0; i < 3; i++) { small.push(ms(2000)); large.push(ms(8000)); }
    const median = values => values.sort((a, b) => a - b)[1];
    const one = Math.max(1, median(small));
    const four = median(large);
    assert.ok(four < one * 8, `${JSON.stringify(unit)}: 길이가 4배인데 비용이 ${(four / one).toFixed(1)}배다 (${one.toFixed(0)}ms → ${four.toFixed(0)}ms)`);
  }
  // 상한 안의 긴 수식은 그대로 조판되고, 넘는 것은 원문으로 남되 던지지 않는다 (실패 방향은 원문 쪽이다)
  const long = n => `\\[ ${'x+'.repeat(n / 2)}y \\]`;
  assert.strictEqual(formulas(long(4000)).length, 1, '4,000자 수식이 조판되지 않았다');
  assert.deepStrictEqual(formulas(long(6000)), [], '상한을 넘는 수식이 조판됐다 — 비용 상한이 사라졌다');
  assert.ok(visible(long(6000)).includes('x+x+'), '상한을 넘는 수식의 원문이 화면에서 사라졌다');
  assert.deepStrictEqual(formulas(`\\( ${'a+'.repeat(2000)}b \\) 와 $c$`), [`${'a+'.repeat(2000)}b`, 'c']);
});
