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

// start_all.sh는 임베딩 모델이 설치돼 있는지 보고 없으면 받는다 — 없으면 임베딩 호출이 매번 실패하고
// 그것은 곧 '검색이 통째로 성립하지 않는다'이기 때문이다(벡터 단일 경로). 그런데 어느 모델인지를
// 셸 환경에서만 읽으면, 문서가 시키는 대로(README '임베딩 모델 교체') backend/.env에서 모델을 바꾼
// 설치에서 옛 이름을 보고 '준비됨'이라 알리고 새 모델은 받지 않는다 — 검사가 막겠다고 한 결과가
// 검사를 통과한 채로 난다. 우선순위는 dotenv와 같아야 한다: 셸 환경 > backend/.env > 기본값.
async function stack(t, envFile) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'start-all-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const sub of ['backend', 'frontend', 'bin']) await mkdir(join(root, sub), { recursive: true });
  await copyFile(new URL('../../start_all.sh', import.meta.url), join(root, 'start_all.sh'));
  if (envFile !== null) await writeFile(join(root, 'backend/.env'), envFile);
  for (const app of ['backend', 'frontend']) {
    await writeFile(join(root, app, 'start.sh'), `#!/usr/bin/env bash\necho "[stub] ${app}"\n`, { mode: 0o755 });
  }
  // 인프라는 전부 대역이다 — 이 검사가 보는 것은 '어느 모델 이름으로 판정하는가'뿐이고,
  // 진짜 docker/brew를 만나면 이 머신의 컨테이너·서비스를 실제로 건드린다.
  const pulled = join(root, 'pulled.txt');
  await writeFile(join(root, 'bin/ollama'), `#!/usr/bin/env bash
case "$1" in
  list) printf 'NAME\\tID\\nbge-m3:latest\\tabc123\\n' ;;
  pull) echo "$2" >> '${pulled}' ;;
esac
`, { mode: 0o755 });
  for (const cmd of ['curl', 'mysqladmin']) {
    await writeFile(join(root, 'bin', cmd), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  }
  for (const cmd of ['docker', 'brew']) {   // 없는 것으로 취급 — Oracle·brew 경로를 타지 않게
    await writeFile(join(root, 'bin', cmd), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  }
  return { root, pulled, path: `${join(root, 'bin')}:${process.env.PATH}` };
}

test('start_all.sh의 임베딩 모델 판정은 backend/.env를 읽고 셸 환경이 그보다 앞선다', posix, async t => {
  const { root, pulled, path } = await stack(t, 'EMBEDDING_URL=http://localhost:11434/v1\nEMBEDDING_MODEL=other-embed\n');
  const run = async extra => {
    const env = { ...process.env, PATH: path, ...extra };
    if (!('EMBEDDING_MODEL' in extra)) delete env.EMBEDDING_MODEL;
    return (await exec('bash', ['start_all.sh'], { cwd: root, env })).stdout;
  };
  const out = await run({});
  assert.match(out, /other-embed/, `.env의 모델 이름으로 판정하지 않았다: ${out}`);
  assert.doesNotMatch(out, /bge-m3 준비됨/, '설치된 옛 모델을 보고 준비됐다고 알렸다');
  assert.equal((await readFile(pulled, 'utf8')).trim(), 'other-embed', '.env가 가리키는 모델을 받지 않았다');

  // 셸 환경이 있으면 그쪽이 이긴다 (dotenv와 같은 우선순위)
  await rm(pulled, { force: true });
  const shell = await run({ EMBEDDING_MODEL: 'shell-embed' });
  assert.match(shell, /shell-embed/);
  assert.equal((await readFile(pulled, 'utf8')).trim(), 'shell-embed');
});

test('start_all.sh는 .env가 없는 새 클론에서 기본 모델로 돌아간다', posix, async t => {
  const { root, pulled, path } = await stack(t, null);
  const env = { ...process.env, PATH: path };
  delete env.EMBEDDING_MODEL;
  const out = (await exec('bash', ['start_all.sh'], { cwd: root, env })).stdout;
  assert.match(out, /임베딩 모델 bge-m3 준비됨/, `기본값으로 돌아가지 않았다: ${out}`);
  await assert.rejects(readFile(pulled, 'utf8'), '이미 설치된 기본 모델을 다시 받았다');
});
