import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { adaptMermaidMath, adaptMermaidLabels, installedMermaidMath, mermaidMathAdapter } from '../mermaid-math-adapter.mjs';
import { MATH_ADAPTER_KEY } from '../../shared/mermaid-math-spans.mjs';
import { hasNativeMermaidMath, renderNativeMermaidLabel, withNativeMermaidMath } from '../src/mermaid-native-math.js';
import { literalMermaidMathML } from '../src/mermaid-math.js';
import { renderMathML } from '../src/math.js';
import { MERMAID_MULTILINE_MATH } from './mermaid-math-corpus.js';

test('Mermaid 네이티브 라벨도 본문 엔진과 같은 MathML을 생성하고 수식 안의 개행·br·verb를 보존한다', async () => {
  for (const text of ['일반 라벨', '첫째<br>둘째', '$$미완성', 'cost $100', '<b>서식</b>'])
    assert.equal(renderNativeMermaidLabel(text), text, '수식이 없는 라벨의 구조가 바뀌었다');
  for (const tex of [MERMAID_MULTILINE_MATH, String.raw`x^2+\verb|$$|`, String.raw`x^2+\verb*+a $$ b+`,
    String.raw`x^2+\text{a<br>b}`, 'x^2 % 달러 예시 $$\n+1', String.raw`\ce{H2O}+x^2`]) {
    const label = '앞<br>$$' + tex + '$$<br/>뒤';
    assert.ok(hasNativeMermaidMath(label));
    const result = await withNativeMermaidMath(async () => ({ html: renderNativeMermaidLabel(label) }));
    assert.deepEqual(result.mathErrors, []);
    assert.equal(result.html, '<div>앞</div><div>' + literalMermaidMathML(renderMathML(tex)) + '</div><div>뒤</div>');
    const tree = fromHtmlIsomorphic(result.html, { fragment: true });
    assert.equal(tree.children.length, 3, 'TeX 안의 br/개행을 라벨 줄로 분할했다');
    assert.equal(hasNativeMermaidMath(result.html), false, '이미 조판한 달러를 다시 실행한다');
  }
});

test('여러 번 측정하는 네이티브 라벨 오류는 한 번만 기록하며 그림 사이에는 누적되지 않는다', async () => {
  const broken = String.raw`$$\unknown{<img src=x>}$$`;
  const result = await withNativeMermaidMath(async () => {
    assert.equal(renderNativeMermaidLabel(broken), '<div>수식 오류 1</div>');
    assert.equal(renderNativeMermaidLabel(broken), '<div>수식 오류 1</div>');
    assert.match(renderNativeMermaidLabel('정상 $$x^2$$'), /<math/);
    return {};
  });
  assert.deepEqual(result.mathErrors, [broken]);
  await assert.rejects(withNativeMermaidMath(async () => { renderNativeMermaidLabel(broken); throw new Error('그림 오류'); }), /그림 오류/);
  assert.deepEqual((await withNativeMermaidMath(async () => ({}))).mathErrors, []);
  assert.throws(() => renderNativeMermaidLabel(broken), /오류 범위/);
});

test('설치된 Mermaid의 유일한 공통 수식 경로를 연결하고 기존 sanitizer를 유지한다', () => {
  const { path, code, labelPath, labelCode } = installedMermaidMath();
  assert.ok(code.includes(MATH_ADAPTER_KEY));
  assert.match(code, /return sanitizeText\(await renderKatexUnsanitized\(text, config2\), config2\)/);
  assert.equal(globalThis[Symbol.for(MATH_ADAPTER_KEY)].renderLabel, renderNativeMermaidLabel);
  const original = readFileSync(path, 'utf8');
  assert.throws(() => adaptMermaidMath(original.replace('var hasKatex =', 'var changedHasKatex =')), /연결 지점/);
  assert.throws(() => adaptMermaidMath(original + original), /연결 지점/);
  assert.throws(() => adaptMermaidMath(code), /연결 지점/);
  assert.ok(labelCode.includes('renderKatexSanitized(node.label, config)'));
  assert.throws(() => adaptMermaidLabels(readFileSync(labelPath, 'utf8').replace('node.label.replace', 'node.changed.replace')), /연결 지점/);
  const plugin = mermaidMathAdapter();
  let load;
  const config = plugin.config();
  config.optimizeDeps.esbuildOptions.plugins[0].setup({ onLoad(_options, callback) { load = callback; } });
  for (const [file, expected] of [[path, code], [labelPath, labelCode]]) for (const separator of ['/', '\\']) {
    const id = file.replaceAll('\\', '/').replaceAll('/', separator);
    assert.equal(plugin.transform('', id + '?v=1').code, expected, '배포 모듈 경로가 연결되지 않았다');
    assert.equal(load({ path: id }).contents, expected, '개발 사전 번들 경로가 연결되지 않았다');
  }
  assert.equal(plugin.transform('', '/unrelated.js'), null);
  assert.equal(load({ path: '/unrelated.js' }), undefined);
  assert.match(JSON.parse(config.optimizeDeps.esbuildOptions.define.__LLM_MERMAID_MATH_ADAPTER__), /^[a-f0-9]{64}$/);
});
