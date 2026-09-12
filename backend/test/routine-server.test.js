import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// 새 DB를 만들지 않는다. 실제 백엔드 프로세스가 오류 후에도 응답하는지를 검증한다.
test('프로시저·함수 오류 후 순차/병렬 조회와 후속 HTTP 요청이 정상 처리된다', { timeout: 20000 }, async t => {
  let log = '';
  const child = spawn(process.execPath, ['--unhandled-rejections=strict', 'test/fixtures/routine-server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: '0', ORACLE_MOCK: '0', ORACLE_DRIVER: 'thin', LLM_PROVIDER: 'mock',
      EMBED_SYNC_INTERVAL: '0', EMBEDDING_URL: '', MARIADB_USER: 'fixture', MARIADB_PASSWORD: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  let port;
  for (let i = 0; i < 100; i++) {
    port = /agent server: http:\/\/localhost:(\d+)/.exec(log)?.[1];
    if (port || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(port, log);
  const base = `http://127.0.0.1:${port}`;
  for (const message of ['sequential', 'healthy', 'batch', 'healthy']) {
    const response = await fetch(base + '/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, log);
    const result = await response.json();
    assert.equal(result.answer, '후속 조회 완료', JSON.stringify(result));
    const failures = result.trace.filter(step => step.error);
    assert.equal(failures.length, message === 'healthy' ? 0 : 2);
    assert.ok(result.trace.some(step => step.query_name === 'healthy' || step.query === 'healthy'), JSON.stringify(result.trace));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SCHEMA/);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  }
  assert.doesNotMatch(log, /\[unhandledRejection\]|\[uncaughtException\]|\[server error\]/);
});
