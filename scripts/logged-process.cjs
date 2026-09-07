const { spawn } = require('node:child_process');
const { createLog, DAY } = require('./retained-log.cjs');
const path = require('node:path');

const log = createLog(path.resolve(process.env.APP_LOG_FILE));
log.write(`===== ${new Date().toISOString()} start =====\n`);
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => log.write(chunk));
child.stderr.on('data', chunk => log.write(chunk));
child.on('error', error => log.write(`[launcher] ${error.stack}\n`));
let rotation;
let stopping;
// Rotate idle logs too. Each write also checks the date after machine sleep.
function schedule() {
  rotation = setTimeout(() => { log.maintain(); schedule(); }, DAY - (Date.now() % DAY));
  rotation.unref();
}
schedule();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) return;
    child.kill(signal);
    stopping = setTimeout(() => child.kill('SIGKILL'), Number(process.env.APP_LOG_STOP_MS) || 11000);
    stopping.unref();
  });
}
child.on('close', (code, signal) => {
  clearTimeout(rotation);
  clearTimeout(stopping);
  if (signal) log.write(`[launcher] process exited on ${signal}\n`);
  process.exitCode = code ?? 1;
});
