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

test('structuredClone 폴리필은 __proto__ 데이터 키를 잃거나 원형으로 바꾸지 않는다', async () => {
  const got = await inChild(`
    const native = globalThis.structuredClone;
    delete globalThis.structuredClone;
    await import('./src/polyfills.js');
    const samples = [JSON.parse('{"__proto__":{"label":"값"},"name":"그림"}'), []];
    Object.defineProperty(samples[1], '__proto__', { value: samples[1], enumerable: true });
    const inspect = clone => samples.map(source => {
      const result = clone(source);
      return {
        keys: Object.keys(result),
        prototype: Object.getPrototypeOf(result) === (Array.isArray(source) ? Array.prototype : Object.prototype),
        own: Object.hasOwn(result, '__proto__'),
        value: Array.isArray(source) ? result.__proto__ === result : result.__proto__.label,
      };
    });
    process.stdout.write(JSON.stringify({actual: inspect(structuredClone), expected: inspect(native)}));
  `);
  assert.deepStrictEqual(got.actual, got.expected);
});

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

test('폴리필의 Array·String.prototype.at은 명세와 같다 — 뒤에서 세고, 범위 밖은 undefined, 원래 있으면 손대지 않는다', async () => {
  // mermaid가 클래스·상태·ER 다이어그램과 markdown 라벨의 파서에서 부른다 — 없는 브라우저(Chrome 87~91·Safari 14~15.3)에서는
  // 그 종류만 원문 코드로 남아 한 답변 안에서 그림이 종류에 따라 되고 안 되고가 갈렸다(실측).
  const got = await inChild(`
    delete Array.prototype.at; delete String.prototype.at;
    const before = [typeof [].at, typeof ''.at];
    await import('./src/polyfills.js');
    const a = ['x', 'y', 'z'];
    const cases = {
      before, after: [typeof [].at, typeof ''.at],
      first: a.at(0), last: a.at(-1), secondLast: a.at(-2), out: String(a.at(3)), outNeg: String(a.at(-4)),
      frac: a.at(1.7), nan: a.at('nope'), str: '가🙂'.at(-1) === '\\uDE42', strFirst: 'abc'.at(0), strOut: String('abc'.at(5)),
      arrayLike: Array.prototype.at.call({ length: 2, 0: 'p', 1: 'q' }, -1),
      enumerable: Object.prototype.propertyIsEnumerable.call(Array.prototype, 'at') || Object.prototype.propertyIsEnumerable.call(String.prototype, 'at'),
    };
    const marker = function () { return 'native'; }; Array.prototype.at = marker;
    await import('./src/polyfills.js?again');
    cases.keepsExisting = Array.prototype.at === marker;
    process.stdout.write(JSON.stringify(cases));
  `);
  assert.deepStrictEqual(got, {
    before: ['undefined', 'undefined'], after: ['function', 'function'],
    first: 'x', last: 'z', secondLast: 'y', out: 'undefined', outNeg: 'undefined', frac: 'y', nan: 'x', str: true, strFirst: 'a', strOut: 'undefined',
    arrayLike: 'q', enumerable: false, keepsExisting: true,
  });
});

test('폴리필의 URL.canParse는 명세와 같다 — 만들 수 있으면 true, 아니면 false, 원래 있으면 손대지 않는다', async () => {
  // mermaid가 그림 안의 링크(flowchart의 `click`, classDiagram의 `link`)를 정화할 때 부른다:
  // formatUrl → @braintree/sanitize-url → isValidUrl → URL.canParse. securityLevel이 'loose'가 아니면(우리는
  // 'strict'다 — Mermaid.jsx) 늘 그 길을 지난다. URL.canParse는 Chrome 120·Safari 17·Firefox 115부터라
  // 빌드 타깃(chrome87·safari14·firefox78) 밖이고, 없는 브라우저에서는 http(s) 링크가 든 그림만
  // 'URL.canParse is not a function'으로 원문 코드가 됐다(실측). 링크 없는 그림은 멀쩡해서 사용자에게는
  // 그림 종류가 아니라 '어떤 그림만' 안 그려지는 것으로 보인다 — Array.prototype.at 때와 같은 모양이다.
  // 빈 문자열 base는 '없음'이 아니라 파싱 실패다(네이티브도 false) — base를 넘길지 말지로 가른다.
  const got = await inChild(`
    const native = URL.canParse;
    // 열거 여부는 지우기 '전에' 재야 한다 — 지운 뒤에 재면 폴리필을 재는 것이라 무엇도 보증하지 않는다.
    const 네이티브도열거되는가 = Object.prototype.propertyIsEnumerable.call(URL, 'canParse');
    delete URL.canParse;
    const before = typeof URL.canParse;
    await import('./src/polyfills.js');
    const p = URL.canParse;
    const 표본 = [['https://ex.test/a'], ['없는주소'], ['/a'], ['/a', 'https://ex.test'], ['/a', '깨진base'],
      ['mailto:a@b.test'], [''], ['https://ex.test/a', undefined], ['https://ex.test/a', ''], ['HTTP://EX.test'], ['//ex.test/a', 'https://b.test']];
    const cases = {
      before, after: typeof p,
      값: 표본.map(args => p(...args)),
      네이티브와같은가: 표본.every(args => p(...args) === native(...args)),
      // 위의 둘(ECMAScript 내장)과 달리 WebIDL의 정적 연산은 열거된다 — 폴리필도 네이티브를 따라야 한다.
      enumerable: Object.prototype.propertyIsEnumerable.call(URL, 'canParse'),
      네이티브도열거되는가,
    };
    const marker = () => 'native'; URL.canParse = marker;
    await import('./src/polyfills.js?again');
    cases.keepsExisting = URL.canParse === marker;
    process.stdout.write(JSON.stringify(cases));
  `);
  assert.deepStrictEqual(got, {
    before: 'undefined', after: 'function',
    값: [true, false, false, true, false, true, false, true, false, true, true],
    네이티브와같은가: true, enumerable: true, 네이티브도열거되는가: true, keepsExisting: true,
  });
});

test('폴리필의 structuredClone은 명세와 같다 — 깊은 복사·순환·옮길 수 없는 값, 원래 있으면 손대지 않는다', async () => {
  // mermaid가 그림을 그리는 길에서 부른다. 앞서 '쓰는 자리가 pie 하나뿐'이라고 적어 두었던 것이 틀렸다:
  // dagre(흐름도 배치)가 **자기 자신을 가리키는 화살표**(`A --> A`)의 모서리를 복제하는 데 쓴다 —
  // structuredClone은 Chrome 98·Safari 15.4·Firefox 94부터라 빌드 타깃(chrome87·safari14·firefox78) 밖이고,
  // 없는 브라우저에서는 그 한 줄이 든 흐름도와 원그래프만 'structuredClone is not defined'로 원문 코드가 됐다
  // (실측: 평범한 흐름도·시퀀스·간트·ER·클래스·상태는 그려졌다 — 그림 종류가 아니라 '그 안에 무엇이 있는가'로 갈린다).
  // 네이티브와 나란히 세워 잰다 — 폴리필의 모양만 보는 검사는 무엇도 보증하지 않는다.
  const got = await inChild(`
    const native = globalThis.structuredClone;
    const 네이티브도열거되는가 = Object.prototype.propertyIsEnumerable.call(globalThis, 'structuredClone');
    delete globalThis.structuredClone;
    const before = typeof globalThis.structuredClone;
    await import('./src/polyfills.js');
    const p = globalThis.structuredClone;
    // 값을 만드는 함수로 둔다 — 같은 표본을 네이티브와 폴리필에 따로 넘겨야 순환 참조도 서로를 침범하지 않는다.
    const 표본 = () => { const a = { s: '가', n: -0, b: true, u: undefined, nul: null, big: 1n,
      arr: [1, [2, { d: new Date(0), re: /a\\+b/gi }]], m: new Map([['k', { v: 1 }]]), st: new Set([1, '가']),
      buf: new Uint8Array([1, 2, 3]), box: Object(5), err: new TypeError('앗') }; a.self = a; return a; };
    const 같은모양 = (x, y, seen = new Map()) => {
      if (Object.is(x, y)) return true;
      if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
      if (seen.get(x) === y) return true;
      seen.set(x, y);
      if (Object.prototype.toString.call(x) !== Object.prototype.toString.call(y)) return false;
      if (x instanceof Date) return +x === +y;
      if (x instanceof RegExp) return x.source === y.source && x.flags === y.flags;
      if (x instanceof Error) return x.name === y.name && x.message === y.message;
      if (x instanceof Map) return x.size === y.size && [...x].every(([k, v], i) => 같은모양(k, [...y][i][0], seen) && 같은모양(v, [...y][i][1], seen));
      if (x instanceof Set) return x.size === y.size && [...x].every((v, i) => 같은모양(v, [...y][i], seen));
      if (ArrayBuffer.isView(x)) return x.length === y.length && [...x].every((v, i) => v === y[i]);
      const kx = Object.keys(x), ky = Object.keys(y);
      return kx.length === ky.length && kx.every(k => 같은모양(x[k], y[k], seen));
    };
    const c = p(표본());
    const cases = {
      before, after: typeof p,
      네이티브와같은가: 같은모양(c, native(표본())),
      깊은복사: c.arr[1][1] !== 표본().arr[1][1] && c.m.get('k').v === 1,
      순환: c.self === c,
      원형은안옮긴다: Object.getPrototypeOf(p(new (class X { constructor() { this.a = 1; } })())) === Object.prototype,
      // 옮길 수 없는 값은 명세대로 DataCloneError — 조용히 빈 객체로 만들면 부르는 쪽이 그것을 값으로 믿는다
      던지는것: ['function', 'symbol', 'method', 'weakmap', 'promise'].map(kind => {
        const v = { function: () => 1, symbol: Symbol('s'), method: { f() {} }, weakmap: new WeakMap(), promise: Promise.resolve() }[kind];
        try { p(v); return 'no-throw'; } catch (e) { return e.name; }
      }),
      네이티브가던지는것: ['function', 'symbol', 'method', 'weakmap', 'promise'].map(kind => {
        const v = { function: () => 1, symbol: Symbol('s'), method: { f() {} }, weakmap: new WeakMap(), promise: Promise.resolve() }[kind];
        try { native(v); return 'no-throw'; } catch (e) { return e.name; }
      }),
      // WebIDL의 연산이라 열거된다 (URL.canParse와 같은 이유)
      enumerable: Object.prototype.propertyIsEnumerable.call(globalThis, 'structuredClone'),
      네이티브도열거되는가,
    };
    const marker = () => 'native'; globalThis.structuredClone = marker;
    await import('./src/polyfills.js?again');
    cases.keepsExisting = globalThis.structuredClone === marker;
    process.stdout.write(JSON.stringify(cases));
  `);
  assert.deepStrictEqual(got, {
    before: 'undefined', after: 'function',
    네이티브와같은가: true, 깊은복사: true, 순환: true, 원형은안옮긴다: true,
    던지는것: ['DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError'],
    네이티브가던지는것: ['DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError', 'DataCloneError'],
    enumerable: true, 네이티브도열거되는가: true, keepsExisting: true,
  });
});
