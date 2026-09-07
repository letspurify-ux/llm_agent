// Shared date-based file retention for the start.sh entry points.
const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;
const dayOf = time => new Date(time).toISOString().slice(0, 10);

function createLog(file, now = Date.now) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const state = `${file}.day`;
  fs.mkdirSync(dir, { recursive: true });
  let day;
  try { day = fs.readFileSync(state, 'utf8').trim(); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) {
    // Legacy append-only logs have no reliable per-record age. Remove them
    // once when adopting retention, rather than keeping possibly old records.
    fs.rmSync(file, { force: true });
    day = undefined;
  }

  function maintain() {
    const today = dayOf(now());
    const cutoff = dayOf(Date.parse(`${today}T00:00:00Z`) - 2 * DAY);
    if (day !== today) {
      if (fs.existsSync(file)) {
        if (day && day >= cutoff && day < today) fs.renameSync(file, `${file}.${day}`);
        else fs.rmSync(file);
      }
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      fs.writeFileSync(state, today, { mode: 0o600 });
      day = today;
    }
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.`)) continue;
      const suffix = name.slice(base.length + 1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(suffix) && (suffix < cutoff || suffix > today)) {
        fs.rmSync(path.join(dir, name));
      }
    }
  }
  maintain();
  return {
    maintain,
    write(chunk, encoding) {
      // Check the day before each write, including immediately after sleep.
      if (day !== dayOf(now())) maintain();
      fs.appendFileSync(file, chunk, { encoding: encoding || 'utf8', mode: 0o600 });
    },
  };
}

module.exports = { createLog, DAY };
