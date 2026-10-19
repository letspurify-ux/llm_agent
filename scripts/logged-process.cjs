const { spawn } = require('node:child_process');
const { createLog, DAY } = require('./retained-log.cjs');
const path = require('node:path');

const log = createLog(path.resolve(process.env.APP_LOG_FILE));
log.write(`===== ${new Date().toISOString()} start =====\n`);
// `--exec <program> [args]` runs a program directly (the Rust backend binary);
// otherwise the arguments are a Node script and its arguments (the frontend's Vite).
const args = process.argv.slice(2);
const [command, commandArgs] = args[0] === '--exec' ? [args[1], args.slice(2)] : [process.execPath, args];
const child = spawn(command, commandArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => log.write(chunk));
child.stderr.on('data', chunk => log.write(chunk));
child.on('error', error => log.write(`[launcher] ${error.stack}\n`));
let rotation;
let stopping;
// Rotate idle logs too. Each write also checks the date after machine sleep.
function schedule() {
  rotation = setTimeout(() => {
    // A rotation that fails is tried again with the next write.
    try { log.maintain(); } catch {}
    schedule();
  }, DAY - (Date.now() % DAY));
  rotation.unref();
}
schedule();
// Stops the server with `signal`, killed past the stop deadline.
function stop(signal) {
  if (stopping) return;
  child.kill(signal);
  stopping = setTimeout(() => child.kill('SIGKILL'), Number(process.env.APP_LOG_STOP_MS) || 11000);
  stopping.unref();
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));
// Whatever else goes wrong here ends the launcher only with its server: left
// behind, the server ran on with its output a broken pipe and nothing to
// stop it (stop.sh signals this launcher, and start.sh then found the port taken).
process.on('uncaughtException', error => {
  log.write(`[launcher] ${error.stack}\n`);
  stop('SIGTERM');
});
child.on('close', (code, signal) => {
  clearTimeout(rotation);
  clearTimeout(stopping);
  if (signal) log.write(`[launcher] process exited on ${signal}\n`);
  process.exitCode = code ?? 1;
});
