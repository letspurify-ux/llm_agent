// Loaded (--require) by logged-process.cjs into the Node server it starts (the
// frontend's Vite): the backend follows its launcher itself (backend/src/launcher.rs).
// The launcher passes on a stop and ends with the server; killed outright
// (SIGKILL: a force quit, the out-of-memory killer), it passed on nothing and
// Vite ran on, orphaned, holding its port — stop.sh, which signals the
// launcher, found nothing to stop, and start.sh started another on the next
// port (seen: ten left behind by interrupted launcher tests, up for days).
// Its end is taken as its stop: SIGTERM, then SIGKILL past the same deadline.
//
// The launcher's end is seen as this process's parent changing (the orphan is
// taken over by another), looked at once a second: a parent's ID is never
// handed back to the child it left, so a reused ID cannot hide the end.
// Only the launcher's own child follows it — a process started further down
// inherits APP_LAUNCHER_PID, but its parent is another.
const launcher = Number(process.env.APP_LAUNCHER_PID);
if (launcher > 0 && process.ppid === launcher && process.platform !== 'win32') {
  const watch = setInterval(() => {
    if (process.ppid === launcher) return;
    clearInterval(watch);
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), Number(process.env.APP_LOG_STOP_MS) || 11000).unref();
  }, 1000);
  // Following the launcher is no reason to run: a script that is done ends.
  watch.unref();
}
