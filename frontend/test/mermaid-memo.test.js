// mermaid의 글자 크기 캐시에 상한을 두는 src/mermaid-memo.js가 실제로 mermaid의 캐시에 닿는가.
//
// 그 수정은 조용히 헛돌 수 있는 자리가 둘이다. ① es-toolkit이 두 벌 깔리면(mermaid가 맞지 않는 버전을 요구하는 날)
// 우리가 바꾼 memoize.Cache는 우리 것에만 걸리고 mermaid의 캐시는 다시 끝없이 자란다. ② mermaid가 memoize를
// 다른 라이브러리에서 가져오기 시작해도 마찬가지다. 둘 다 오류도, 화면의 차이도 없다 — 탭이 오래 열려 있을수록
// 메모리만 는다. 그래서 여기서 그 전제를 못 박는다. (import 순서 — mermaid보다 먼저 평가되는가 — 는 실제 번들에서만
// 보이므로 화면 검사 ui.test.mjs가 힙 스냅샷으로 잰다.)
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundedCache, MEMO_LIMIT } from '../src/mermaid-memo.js';
import { memoize } from 'es-toolkit/compat';

const mermaidEntry = fileURLToPath(import.meta.resolve('mermaid'));

test('mermaid와 화면이 같은 es-toolkit 한 벌을 쓴다', () => {
  const ours = createRequire(import.meta.url).resolve('es-toolkit/compat');
  const theirs = createRequire(mermaidEntry).resolve('es-toolkit/compat');
  assert.strictEqual(theirs, ours,
    'es-toolkit이 두 벌 깔렸다 — src/mermaid-memo.js가 바꾼 memoize.Cache가 mermaid의 캐시에 닿지 않는다(package.json의 es-toolkit 범위를 mermaid에 맞출 것)');
});

test('mermaid는 글자 크기 캐시를 es-toolkit의 memoize로 만든다', async () => {
  const dirs = [dirname(mermaidEntry), join(dirname(mermaidEntry), 'chunks', 'mermaid.core')];
  const sources = new Set();
  for (const dir of dirs) {
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.mjs'))) {
      const text = await readFile(join(dir, name), 'utf8');
      for (const [, names, from] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
        if (/\bmemoize\b/.test(names)) sources.add(from);
      }
    }
  }
  assert.deepStrictEqual([...sources], ['es-toolkit/compat'],
    `mermaid가 memoize를 가져오는 곳이 바뀌었다: ${JSON.stringify([...sources])} — src/mermaid-memo.js가 그 캐시에 닿는지 다시 볼 것`);
});

test('mermaid-memo.js를 읽은 뒤 만들어진 memoize의 캐시는 상한을 넘지 않는다', () => {
  assert.strictEqual(memoize.Cache, BoundedCache);
  let calls = 0;
  const measure = memoize(text => { calls += 1; return { width: text.length }; }, text => `${text}12400Arial`);
  assert.ok(measure.cache instanceof BoundedCache);
  for (let i = 0; i < MEMO_LIMIT * 3; i++) {
    assert.deepStrictEqual(measure(`라벨 ${i}`), { width: `라벨 ${i}`.length });
    // 그리는 도중 거듭 쓰는 글자는 밀려나지 않는다 — 가장 오래 '쓰지 않은' 것부터 버린다.
    measure('늘 쓰는 글자');
  }
  assert.strictEqual(measure.cache.size, MEMO_LIMIT);
  assert.strictEqual(calls, MEMO_LIMIT * 3 + 1, '같은 글자는 다시 재지 않는다');
  const before = calls;
  measure('늘 쓰는 글자');
  measure(`라벨 ${MEMO_LIMIT * 3 - 1}`);
  assert.strictEqual(calls, before, '최근에 쓴 글자는 캐시에 남아 있다');
  measure('라벨 0');
  assert.strictEqual(calls, before + 1, '가장 오래 쓰지 않은 글자는 버려져 다시 잰다');
});
