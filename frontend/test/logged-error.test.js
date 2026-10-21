// src/logged-error.js released()가 오류에 매달린 스택 프레임을 실제로 놓게 하는가.
//
// V8은 오류의 스택을 처음 읽기 전까지 던진 순간의 프레임(함수와 그 클로저가 붙든 값)을 오류에 매단다. 크롬은 콘솔
// 메시지를 인자째 보관하므로, 그 오류를 콘솔로 넘기면 던진 자리의 데이터가 탭이 열려 있는 내내 남는다(실측: 마크다운
// 파서가 스택 넘침으로 던진 답 하나에 약 4MB). 수거는 GC를 직접 불러야 잴 수 있어 --expose-gc를 준 아이 프로세스에서
// 잰다 — 오류는 계속 붙들고(콘솔 보관소처럼), 클로저가 붙들던 객체가 수거되는지만 본다.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE = fileURLToPath(new URL('../src/logged-error.js', import.meta.url));

const probe = release => spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
  import { released } from ${JSON.stringify(MODULE)};
  let ref;
  function parse() {
    const tree = { nodes: new Array(1000).fill(0).map((_, i) => ({ i })) };
    ref = new WeakRef(tree);
    const visit = depth => { void tree; if (depth > 3) throw new RangeError('너무 깊다'); return visit(depth + 1); };
    try { visit(0); } catch (e) { return e; }
  }
  const kept = [${release ? 'released(parse())' : 'parse()'}];   // 콘솔 보관소처럼 오류를 계속 붙든다
  for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise(r => setTimeout(r, 10)); }
  console.log(JSON.stringify({ alive: ref.deref() !== undefined, message: kept[0].message, stack: kept[0].stack.includes('visit') }));
`], { encoding: 'utf8' });

test('released()를 지난 오류는 메시지와 스택 글자만 남기고 던진 자리의 데이터를 놓는다', () => {
  const run = probe(true);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), { alive: false, message: '너무 깊다', stack: true });
});

test('검사의 전제: 스택을 읽지 않은 오류는 던진 자리의 데이터를 붙든다', () => {
  // 이것이 거짓이 되면(V8이 프레임을 처음부터 붙들지 않게 되면) 위 검사는 아무것도 재지 않는다.
  const run = probe(false);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(JSON.parse(run.stdout).alive, true);
});
