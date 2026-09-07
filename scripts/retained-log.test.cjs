const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLog } = require('./retained-log.cjs');

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
