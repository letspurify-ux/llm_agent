// 검사가 띄운 것을 정말로 내리는가의 회귀 테스트 — 실행: npm test (frontend/)
//
// UI 검사는 실행마다 headless Chrome을 한 벌 띄운다. 내리는 쪽이 '내렸다'고 잘못 답하면 그것이
// 실행마다 한 벌씩 쌓여 개발자의 컴퓨터가 몇 번 만에 잠긴다 — 그런데 그 실패는 검사 결과에는
// 초록불로 남는다. 브라우저 없이 같은 모양(detached 프로세스 그룹)을 만들어 여기서 재현한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopProcess, killOnExit, sleep } from './ui/driver.mjs';

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), 'ui', 'driver.mjs');
const 그룹이_남았나 = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const 살아있나 = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const 윈도우 = process.platform === 'win32';   // 프로세스 그룹·신호가 이 모양으로 있지 않다

// 우두머리는 먼저 끝나고 도우미 하나가 TERM을 무시한 채 남는다 — Chrome이 남던 그 모양이다
// (브라우저 프로세스는 신호를 받고 나가는데 렌더러·GPU 도우미가 남아 지운 프로필을 붙든다).
const 도우미가_남는_그룹 = () => {
  const p = spawn('/bin/sh', ['-c', '(trap "" TERM; sleep 30) & sleep 0.3; exit 0'], { detached: true, stdio: 'ignore' });
  p.unref();
  return p;
};

test('우두머리가 먼저 끝나도, 남은 도우미까지 내려간 뒤에야 내렸다고 답한다', { skip: 윈도우 }, async () => {
  const p = 도우미가_남는_그룹();
  await sleep(600);                       // 우두머리가 스스로 끝나기를 기다린다
  assert.strictEqual(p.exitCode !== null || p.signalCode !== null, true, '우두머리가 아직 끝나지 않았다 (검사의 전제)');
  assert.ok(그룹이_남았나(p.pid), '도우미가 남아 있지 않다 (검사의 전제)');
  try {
    // 우두머리의 exit만 보던 때에는 여기서 0ms에 true가 나왔고 그룹은 그대로 살아 있었다.
    assert.strictEqual(await stopProcess(p, { group: true, graceMs: 300 }), true, '내리지 못했다');
    assert.strictEqual(그룹이_남았나(p.pid), false, '내렸다고 답했는데 도우미가 남아 있다');
  } finally {
    try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 이미 없다 */ }
  }
});

test('SIGTERM에 곧바로 죽지 않는 그룹도 SIGKILL까지 가서 내린다', { skip: 윈도우 }, async () => {
  const p = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 30'], { detached: true, stdio: 'ignore' });
  p.unref();
  await sleep(200);
  try {
    assert.strictEqual(await stopProcess(p, { group: true, graceMs: 300 }), true, 'SIGKILL까지 가지 못했다');
    assert.strictEqual(그룹이_남았나(p.pid), false, '내렸다고 답했는데 그룹이 남아 있다');
    // '내렸다'고 답한 순간에는 우두머리도 수확된 뒤여야 한다. 그룹이 빈 것만 보고 답하면, 죽었으나
    // 아직 좀비로 남은 사이가 있어 부르는 쪽의 process.kill(pid, 0)은 여전히 성공한다 — UI 검사의
    // '정말 사라졌는가'가 그래서 어쩌다 한 번 어긋났다.
    assert.strictEqual(살아있나(p.pid), false, '내렸다고 답했는데 우두머리가 아직 남아 있다(좀비)');
    assert.ok(p.exitCode !== null || p.signalCode !== null, '우두머리의 끝을 거두기도 전에 내렸다고 답했다');
  } finally {
    try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 이미 없다 */ }
  }
});

test('Ctrl-C로 검사를 끊어도 띄운 브라우저가 남지 않는다', { skip: 윈도우 }, async () => {
  // 끊긴 실행에서는 after()가 돌지 않는다. detached로 띄운 것은 부모를 따라 죽지도 않으므로,
  // 그 길을 덮어 두지 않으면 Ctrl-C 한 번마다 브라우저가 한 벌씩 남는다.
  const 아이 = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { killOnExit } from ${JSON.stringify(DRIVER)};
    const p = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    p.unref();
    killOnExit(() => [{ proc: p, group: true }]);
    process.stdout.write(String(p.pid) + '\\n');
    setTimeout(() => {}, 30_000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await new Promise((res, rej) => {
    // 시간 제한은 받고 나면 걷는다 — 남겨 두면 그 타이머 하나가 이벤트 루프를 붙들어, 이미 끝난
    // 단위 검사가 10초를 더 앉아 있다가 끝난다(실측: 0.5초짜리 묶음이 11초가 되었다).
    const 시간초과 = setTimeout(() => rej(new Error('띄운 프로세스의 pid를 받지 못했습니다')), 10_000);
    const 끝 = fn => v => { clearTimeout(시간초과); fn(v); };
    아이.stdout.once('data', 끝(d => res(Number(String(d).trim()))));
    아이.once('error', 끝(rej));
  });
  try {
    assert.ok(그룹이_남았나(pid), '띄우지 못했다 (검사의 전제)');
    아이.kill('SIGINT');                                    // Ctrl-C
    await new Promise(res => 아이.once('exit', res));
    await sleep(200);
    assert.strictEqual(그룹이_남았나(pid), false, '끊긴 실행이 띄운 것을 남겼다');
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 이미 없다 */ }
    아이.kill('SIGKILL');
  }
});

test('열리지 않는 연결은 시간 안에 포기하고, 붙잡던 소켓도 놓는다', async () => {
  // TCP는 받아 주면서 손짓(WebSocket 업그레이드)에는 답하지 않는 상대 — 죽어 가는 브라우저가
  // 이 모양이다. 시간 제한이 없으면 그 await가 영영 풀리지 않고, 거절하면서 소켓을 닫지 않으면
  // 이번에는 그 손잡이 하나가 node를 끝나지 못하게 붙잡는다. 둘 다 결과는 같다: 검사가 실패도
  // 아니고 끝나지도 않는다(node:test에는 기본 시간 제한이 없어 CI에서는 작업 시간을 통째로 태운다).
  const 소켓들 = new Set();
  const 서버 = createServer();
  서버.on('connection', c => { 소켓들.add(c); c.on('close', () => 소켓들.delete(c)); });
  서버.on('upgrade', () => { /* 받아만 두고 답하지 않는다 */ });
  await new Promise(res => 서버.listen(0, '127.0.0.1', res));
  const { port } = 서버.address();
  // 아이는 소켓 하나만 들고 있다 — 그것을 놓으면 스스로 끝나고, 놓지 않으면 끝나지 못한다.
  const 아이 = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Page } from ${JSON.stringify(DRIVER)};
    try { await Page.open('ws://127.0.0.1:${port}/x', { timeoutMs: 800 }); process.stdout.write('열렸다\\n'); }
    catch (e) { process.stdout.write('거절: ' + e.message + '\\n'); }
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let 말 = '';
  아이.stdout.on('data', d => { 말 += d; });
  try {
    const 끝났나 = await Promise.race([
      new Promise(res => 아이.once('exit', () => res(true))),
      sleep(6000).then(() => false),
    ]);
    assert.match(말, /거절:/, `시간 제한에 걸려 거절하지 않았다: ${JSON.stringify(말)}`);
    assert.ok(끝났나, '거절한 뒤에도 소켓을 놓지 않아 node가 끝나지 못했다');
  } finally {
    아이.kill('SIGKILL');
    for (const c of 소켓들) c.destroy();
    서버.close();
  }
});
