// 로컬과 CI가 같은 필수 검사를 실행한다. DB·LLM 접속은 필요 없다.
import { spawnSync } from 'node:child_process';
import { findChrome } from './ui/driver.mjs';

await findChrome({ required: true });
const env = { ...process.env, REQUIRE_CHROME: '1' };
for (const [command, args, cwd] of [
  [process.execPath, ['--test', '--test-concurrency=1', 'test/llm-openai.test.js', 'test/chart.test.js',
    'test/markdown-syntax.test.js'], new URL('../../backend/', import.meta.url)],
  [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:all'], new URL('../', import.meta.url)],
]) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
