const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLog } = require('./retained-log.cjs');

test('launcher preserves failure status and drains both output pipes before exiting', { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logged-process-drain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'backend.log');
  const child = spawn(process.execPath, [path.join(__dirname, 'logged-process.cjs'), '-e', `
    process.stdout.write('OUT'.repeat(100_000) + 'stdout end\\n');
    process.stderr.write('ERR'.repeat(100_000) + 'stderr end\\n');
    process.exitCode = 7;
  `], { env: { ...process.env, APP_LOG_FILE: file }, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 7);
  const content = fs.readFileSync(file, 'utf8').replace(/^===== .* start =====\n/, '');
  // stdout/stderr chunks may interleave in the middle of a repeated token.
  for (const letter of ['O', 'U', 'T', 'E']) assert.equal(content.split(letter).length - 1, 100_000);
  assert.equal(content.split('R').length - 1, 200_000);
  assert.match(content, /stdout end/);
  assert.match(content, /stderr end/);
});

test('launcher kills a server that ignores SIGTERM within its shutdown deadline', { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logged-process-force-'));
  const file = path.join(dir, 'backend.log');
  let serverPid;
  const child = spawn(process.execPath, [path.join(__dirname, 'logged-process.cjs'), '-e', `
    process.on('SIGTERM', () => {});
    console.log('ready pid=' + process.pid);
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, APP_LOG_FILE: file, APP_LOG_STOP_MS: '100' }, stdio: 'ignore' });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (serverPid) { try { process.kill(serverPid, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const closed = new Promise(resolve => child.on('close', resolve));
  const deadline = Date.now() + 5000;
  while (!serverPid) {
    if (fs.existsSync(file)) serverPid = Number(fs.readFileSync(file, 'utf8').match(/ready pid=(\d+)/)?.[1]);
    assert.ok(Date.now() < deadline, 'server should install its signal handler');
    if (!serverPid) await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGTERM');
  assert.equal(await closed, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /process exited on SIGKILL/);
  assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
  serverPid = undefined;
});

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

async function waitFor(check, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = check();
    if (found) return found;
    assert.ok(Date.now() < deadline, what);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// A launcher over a server that writes a line every 20 ms and stops in order
// on SIGTERM, logging into `logs/backend.log` of a fresh folder.
function launchChatty(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const logs = path.join(dir, 'logs');
  const file = path.join(logs, 'backend.log');
  const launcher = spawn(process.execPath, [path.join(__dirname, 'logged-process.cjs'), '-e', `
    console.log('ready pid=' + process.pid);
    let n = 0;
    setInterval(() => console.log('line ' + n++), 20);
    process.on('SIGTERM', () => { console.log('stopped in order'); process.exit(0); });
  `], { env: { ...process.env, APP_LOG_FILE: file }, stdio: 'ignore' });
  const closed = new Promise(resolve => launcher.on('close', resolve));
  const started = waitFor(() => read(file).match(/ready pid=(\d+)/), 'the server should start').then(m => Number(m[1]));
  t.after(async () => {
    if (launcher.exitCode === null) launcher.kill('SIGKILL');
    try { process.kill(await started, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { launcher, closed, started, logs, file };
}

// A log write that failed (its folder removed) threw out of the launcher:
// it ended and its server ran on unlogged, its output a broken pipe, with
// nothing to stop it (stop.sh found no launcher, start.sh the port taken).
test('launcher outlives its log folder removed and keeps its server under it', { timeout: 15_000 }, async t => {
  const { launcher, closed, started, logs, file } = launchChatty(t, 'logged-process-removed-');
  await started;
  fs.rmSync(logs, { recursive: true, force: true });
  await waitFor(() => /line \d+/.test(read(file)), 'logging should go on in a folder made anew');
  assert.equal(launcher.exitCode, null, 'the launcher runs on');
  assert.ok(fs.existsSync(`${file}.day`), 'the log keeps its date');
  launcher.kill('SIGTERM');
  assert.equal(await closed, 0);
  assert.match(read(file), /stopped in order/);
});

test('launcher outlives a log it cannot write and notes the output lost', { timeout: 15_000 }, async t => {
  const { launcher, closed, started, logs, file } = launchChatty(t, 'logged-process-unwritable-');
  await started;
  fs.rmSync(logs, { recursive: true, force: true });
  fs.writeFileSync(logs, 'a file where the log folder was');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(launcher.exitCode, null, 'the launcher runs on');
  fs.rmSync(logs);
  const note = await waitFor(
    () => read(file).match(/\[launcher\] (\d+) bytes of output could not be written to the log \((\w+)\)/),
    'the lost output should be noted',
  );
  assert.ok(Number(note[1]) > 0 && ['ENOTDIR', 'EEXIST'].includes(note[2]), note[0]);
  launcher.kill('SIGTERM');
  assert.equal(await closed, 0);
  assert.match(read(file), /stopped in order/);
});

test('rotation retains only today and two preceding UTC dates, including idle cleanup and restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'backend.log');
  let now = Date.parse('2026-09-01T23:59:59Z');
  fs.writeFileSync(file, 'legacy records with unknown ages');
  let log = createLog(file, () => now);
  log.write('day1\n');
  for (let day = 2; day <= 4; day++) {
    now = Date.parse(`2026-09-0${day}T00:00:00Z`);
    log.write(Buffer.from(`day${day}\n`));
  }
  assert.equal(fs.existsSync(`${file}.2026-09-01`), false);
  assert.equal(fs.readFileSync(`${file}.2026-09-02`, 'utf8'), 'day2\n');
  assert.equal(fs.readFileSync(`${file}.2026-09-03`, 'utf8'), 'day3\n');
  log = createLog(file, () => now);
  log.write('restart\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'day4\nrestart\n');
  fs.writeFileSync(path.join(dir, 'unrelated.log'), 'keep');
  now = Date.parse('2026-09-08T00:00:00Z');
  log.maintain();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['backend.log', 'backend.log.day', 'unrelated.log']);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('launcher captures stdout/stderr and forwards SIGTERM through shutdown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logged-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'frontend.log');
  const child = spawn(process.execPath, [path.join(__dirname, 'logged-process.cjs'), '-e', `
    process.on('SIGTERM', () => { console.error('shutdown complete'); process.exit(0); });
    console.log('ready'); console.error('stderr captured');
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, APP_LOG_FILE: file }, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const closed = new Promise(resolve => child.on('close', resolve));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('stderr captured')) {
    assert.ok(Date.now() < deadline, 'child should start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGTERM');
  assert.equal(await closed, 0);
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /ready/);
  assert.match(content, /stderr captured/);
  assert.match(content, /shutdown complete/);
});
