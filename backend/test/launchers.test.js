import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const exec = promisify(execFile);
const posix = { skip: process.platform === 'win32', timeout: 20_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function projects(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'backend-launchers-')));
  const dirs = [join(root, 'our app'), join(root, 'other app')];
  for (const dir of dirs) {
    for (const sub of ['node_modules', 'src', 'scripts']) await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, 'src/server.js'), "console.log('ready'); setInterval(() => {}, 1000);\n");
    await writeFile(join(dir, 'scripts/ensure-env.js'), '');
    for (const script of ['start.sh', 'stop.sh', 'process.sh']) {
      await copyFile(new URL(`../${script}`, import.meta.url), join(dir, script));
    }
  }
  const p = spawn(process.execPath, ['src/server.js'], { cwd: dirs[1], stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    for (const dir of dirs) {
      const pid = Number(await readFile(join(dir, '.backend.pid'), 'utf8').catch(() => '0'));
      if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    p.kill('SIGTERM');
    if (p.exitCode === null && p.signalCode === null) await once(p, 'exit');
    await rm(root, { recursive: true, force: true });
  });
  await once(p.stdout, 'data');
  await writeFile(join(dirs[0], '.backend.pid'), String(p.pid));
  return { ours: dirs[0], foreign: p };
}

test('stop.sh는 다른 프로젝트의 src/server.js PID를 종료하지 않는다', posix, async t => {
  const { ours, foreign } = await projects(t);
  await exec('bash', ['stop.sh'], { cwd: ours });
  assert.ok(alive(foreign.pid), '다른 프로젝트 서버를 종료했다');
});

test('start.sh는 다른 프로젝트의 PID를 무시하고 자기 서버만 시작·중지한다', posix, async t => {
  const { ours, foreign } = await projects(t);
  await exec('bash', ['start.sh'], { cwd: ours });
  const pid = Number(await readFile(join(ours, '.backend.pid'), 'utf8'));
  assert.notEqual(pid, foreign.pid, '다른 서버를 이미 실행 중인 자기 서버로 오인했다');
  assert.ok(alive(pid));
  await exec('bash', ['start.sh'], { cwd: ours });
  assert.equal(Number(await readFile(join(ours, '.backend.pid'), 'utf8')), pid);
  await exec('bash', ['stop.sh'], { cwd: ours });
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false);
  assert.ok(alive(foreign.pid));
});
