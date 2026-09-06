import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { alive, sleep, stopProcess } from './ui/driver.mjs';

const exec = promisify(execFile);
const posix = { skip: process.platform === 'win32' };

// 실제 개발 서버를 건드리지 않고, 같은 명령 이름을 가진 두 프로젝트를 만든다.
async function projects(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'frontend-launchers-')));
  const dirs = [join(root, 'our app'), join(root, 'other app')];
  for (const dir of dirs) {
    await mkdir(join(dir, 'node_modules/vite/bin'), { recursive: true });
    await writeFile(join(dir, 'node_modules/vite/bin/vite.js'), "console.log('ready'); setInterval(() => {}, 1000);\n");
    for (const script of ['start.sh', 'stop.sh', 'process.sh']) await copyFile(new URL(`../${script}`, import.meta.url), join(dir, script));
  }
  t.after(async () => {
    for (const dir of dirs) {
      const pid = Number(await readFile(join(dir, '.frontend.pid'), 'utf8').catch(() => '0'));
      if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    await rm(root, { recursive: true, force: true });
  });
  return dirs;
}

async function foreignVite(t, dir) {
  const p = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => stopProcess(p));
  await once(p.stdout, 'data');
  return p;
}

test('stop.sh는 다른 프로젝트의 Vite PID를 자기 서버로 오인하지 않는다', posix, async t => {
  const [ours, other] = await projects(t);
  const p = await foreignVite(t, other);
  await writeFile(join(ours, '.frontend.pid'), String(p.pid));
  await exec('bash', ['stop.sh'], { cwd: ours });
  assert.ok(alive(p.pid), '다른 프로젝트의 Vite가 종료됐다');
});

test('start.sh는 다른 프로젝트의 Vite가 살아 있어도 자기 서버를 시작한다', posix, async t => {
  const [ours, other] = await projects(t);
  const p = await foreignVite(t, other);
  await writeFile(join(ours, '.frontend.pid'), String(p.pid));
  await exec('bash', ['start.sh'], { cwd: ours });
  const pid = Number(await readFile(join(ours, '.frontend.pid'), 'utf8'));
  assert.notEqual(pid, p.pid, '다른 서버를 이미 실행 중인 자기 서버로 오인했다');
  assert.ok(alive(pid));
  assert.ok(alive(p.pid));
  // 중복 시작은 같은 PID를 유지하고, 정상 중지는 실제로 그 서버를 내린다.
  await exec('bash', ['start.sh'], { cwd: ours });
  assert.equal(Number(await readFile(join(ours, '.frontend.pid'), 'utf8')), pid);
  await exec('bash', ['stop.sh'], { cwd: ours });
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false);
  assert.ok(alive(p.pid));
});
