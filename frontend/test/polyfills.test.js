// 빌드 타깃 안의 옛 브라우저에 없는 런타임 API 채우기(polyfills.js) 회귀 테스트 — 실행: npm test (frontend/)
//
// 이 결함은 지원 범위 안의 브라우저에서만 나고 오류는 콘솔에만 남는다: Object.hasOwn(Chrome 93·Safari 15.4부터)이
// 없으면 react-markdown이 렌더 도중에 던져 모든 답변이 '이 답변을 그리지 못했습니다' 원문 폴백이 된다(실측).
// node에는 그 API가 있으므로 아이 프로세스에서 지운 뒤 진입점과 같은 순서로 폴리필을 읽고, 화면과 같은
// 파이프라인(math.js의 플러그인 + markdown.js의 한 벌)으로 답변을 실제로 그려 본다 — 폴리필의 모양만 보는
// 검사는 그것을 부르는 라이브러리가 바뀐 날 아무것도 보지 않는다.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 아이 프로세스에서 스크립트를 돌리고 stdout(JSON 한 줄)을 받는다.
function inChild(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err.slice(0, 800)}`))));
  });
}

test('Object.hasOwn이 없는 브라우저에서도 답변이 markdown으로 그려진다 (폴리필이 진입점보다 먼저 읽힌다)', async () => {
  const got = await inChild(`
    delete Object.hasOwn;
    const before = typeof Object.hasOwn;
    await import('./src/polyfills.js');
    const React = (await import('react')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const ReactMarkdown = (await import('react-markdown')).default;
    const { REMARK_PLUGINS, REHYPE_PLUGINS } = await import('./src/math.js');
    const { mdProps } = await import('./src/markdown.js');
    const props = mdProps({ img: () => null, a: p => React.createElement('a', { href: p.href }, p.children) });
    const md = '## 제목\\n\\n**굵게** $x^2$ https://ex.test/a\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n![그림](https://ex.test/x.png)';
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, ...props }, md));
    process.stdout.write(JSON.stringify({ before, after: typeof Object.hasOwn, html }));
  `);
  assert.strictEqual(got.before, 'undefined', '검사의 전제: 아이 프로세스에서 Object.hasOwn을 지웠다');
  assert.strictEqual(got.after, 'function', '폴리필이 Object.hasOwn을 채우지 않았다');
  assert.ok(got.html.includes('<h2>') && got.html.includes('<strong>') && got.html.includes('<table>'), `답변이 markdown으로 그려지지 않았다: ${got.html.slice(0, 200)}`);
  assert.ok(got.html.includes('href="https://ex.test/a"'), '맨 URL 자동 링크가 사라졌다');
  assert.ok(got.html.includes('katex'), '수식이 그려지지 않았다');
});

test('폴리필의 Object.hasOwn은 명세와 같다 — 상속은 false, null·undefined는 던지고, 원래 있으면 손대지 않는다', async () => {
  const got = await inChild(`
    const native = Object.hasOwn;
    delete Object.hasOwn;
    await import('./src/polyfills.js');
    const p = Object.hasOwn;
    const cases = {
      own: p({ a: 1 }, 'a'), inherited: p(Object.create({ a: 1 }), 'a'), missing: p({}, 'a'),
      symbol: (() => { const s = Symbol('s'); return p({ [s]: 1 }, s); })(),
      numberKey: p(['x'], 0), stringObj: p('ab', 'length'), overridden: p({ hasOwnProperty: () => false, a: 1 }, 'a'),
      nullProto: p(Object.create(null, { a: { value: 1 } }), 'a'),
      nullThrows: (() => { try { p(null, 'a'); return false; } catch (e) { return e instanceof TypeError; } })(),
      undefinedThrows: (() => { try { p(undefined, 'a'); return false; } catch (e) { return e instanceof TypeError; } })(),
      enumerable: Object.prototype.propertyIsEnumerable.call(Object, 'hasOwn'),
      sameAsNative: ['a', 'b'].every(k => p({ a: 1 }, k) === native({ a: 1 }, k)),
    };
    // 이미 있으면 그대로 둔다
    const marker = () => 'native'; Object.hasOwn = marker;
    await import('./src/polyfills.js?again');
    cases.keepsExisting = Object.hasOwn === marker;
    process.stdout.write(JSON.stringify(cases));
  `);
  assert.deepStrictEqual(got, {
    own: true, inherited: false, missing: false, symbol: true, numberKey: true, stringObj: true, overridden: true, nullProto: true,
    nullThrows: true, undefinedThrows: true, enumerable: false, sameAsNative: true, keepsExisting: true,
  });
});

test('진입점은 무엇보다 먼저 폴리필을 읽는다 (main.jsx)', async () => {
  // ES 모듈은 import가 적힌 순서대로 평가된다 — 이 줄이 react-markdown보다 뒤에 있으면 폴리필은 있어도 늦다.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(join(ROOT, 'src', 'main.jsx'), 'utf8');
  const imports = [...src.matchAll(/^import\b.*$/gm)].map(m => m[0]);
  assert.ok(imports.length > 1, '진입점에 import가 없다 (검사의 전제)');
  assert.match(imports[0], /polyfills\.js/, `첫 import가 폴리필이 아니다: ${imports[0]}`);
});
