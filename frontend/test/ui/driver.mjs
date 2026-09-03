// UI 회귀 테스트용 최소 브라우저 드라이버. 의존성을 더하지 않으려고 CDP(Chrome DevTools Protocol)를
// 직접 쓴다 — node의 내장 WebSocket과 fetch만 있으면 된다.
//
// 탭은 하나만 쓴다. 검사를 돌릴 때마다 새 탭을 열면 브라우저가 수십 개를 안고 느려지다 멈춘다.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 이 프로세스가(그룹이) 아직 있는가. 신호 0은 보내지 않고 존재만 묻는다.
// 한 곳에 둔다 — 내리는 쪽(아래 stopProcess)과 '정말 내려갔나'를 재는 쪽(ui.test.mjs·process.test.js)이
// 같은 판정을 써야, 그중 하나를 고친 날 검사와 드라이버가 다른 것을 보지 않는다.
// EPERM은 '없다'가 아니다: 프로세스는 있는데 우리 것이 아니라는 답이다(macOS에서 Chrome의 도우미가
// 다른 주인에게 넘어가면 이 답이 온다). 그것을 '없다'로 읽으면 남은 브라우저를 내려갔다고 답하게 된다.
export const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
};
// 우두머리가 죽어도 렌더러 하나가 남으면 그룹은 남는다 — 음수 pid가 그룹이다.
export const aliveGroup = pid => alive(-pid);

// 설치 위치는 OS마다 다르다. 없으면 UI 검사는 건너뛴다(단위 테스트는 그것과 무관하게 돈다).
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const p of CHROME_PATHS) {
    try { await access(p); return p; } catch { /* 다음 후보 */ }
  }
  return null;
}

// 비어 있는 포트 하나. 우리가 정한 번호를 고집하면 남의 것과 부딪혔을 때 검사가 실패로 남는다.
// 127.0.0.1이 아니라 모든 인터페이스에 붙여 본다 — vite도 그렇게 붙으므로(vite.config.js host),
// 되돌이 주소만 비어 있는 포트를 '비었다'고 답하면 vite가 --strictPort에서 그대로 죽는다.
export const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

// 디버깅 포트는 우리가 고르지 않고 Chrome이 고르게 한다(--remote-debugging-port=0). 번호를 박아 두면
// 앞선 실행이 남긴 브라우저가 그 포트를 쥐고 있을 때 이번에 띄운 것이 아니라 그 남은 브라우저에
// 붙는다 — 아무도 관리하지 않는 창을 상대로 검사가 초록불을 낸다. Chrome은 고른 번호를 프로필의
// DevToolsActivePort 첫 줄에 적어 주므로, 그 파일이 '이번에 띄운 그 브라우저'라는 증거가 된다.
export function launchChrome({ bin, profile }) {
  const p = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1200,900', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--disable-features=Translate,BackForwardCache',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  p.unref();
  return p;
}

export async function chromePort(profile, { timeoutMs = 30_000 } = {}) {
  const file = join(profile, 'DevToolsActivePort');
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
    try {
      const port = Number((await readFile(file, 'utf8')).split('\n')[0]);
      if (port > 0) return port;
    } catch { /* 아직 안 적혔다 */ }
    await sleep(200);
  }
  throw new Error(`Chrome이 디버깅 포트를 적어 주지 않았습니다 — 뜨지 못한 것 같습니다 (${file})`);
}

// 띄운 브라우저를 '끝났다'까지 확인하고 내린다. kill()은 신호를 보낼 뿐이고, 차트·흐름도가 선 화면을
// 안고 있는 headless Chrome은 SIGTERM 하나로는 내려가지 않는다(확인: 7초 뒤에도 살아 있었다).
// 기다리지 않으면 검사를 한 번 돌릴 때마다 브라우저가 한 벌씩 쌓이고, 지운 프로필 폴더를 붙든 채
// 남는다. 띄운 것 모두(개발 서버도)에 같은 규칙을 쓴다 — kill()이 신호일 뿐인 것은 어느 쪽도 같다.
// group: detached로 띄운 것에만 켠다. 그때는 pid가 곧 프로세스 그룹이라 렌더러·GPU 도우미까지 함께
// 받는다(Chrome). detached가 아닌 자식의 pid로 그룹에 보내면 남의 그룹을 깨울 수 있다.
// group일 때 '끝났다'의 기준은 우두머리가 아니라 그룹이다. 우두머리의 exit만 보면, SIGTERM에
// 브라우저 프로세스는 나가고 렌더러 하나가 남는 흔한 모양에서 곧바로 '끝났다'가 되어 SIGKILL까지
// 가지 못한다 — 부르는 쪽은 다 내려갔다고 듣고, 지운 프로필을 붙든 Chrome은 남는다.
// (확인: 우두머리가 먼저 끝난 그룹에 stopProcess를 부르면 0ms에 true를 주고 그룹은 살아 있었다.
//  아래 test/process.test.js가 그 모양을 그대로 재현한다.)
export function stopProcess(proc, { graceMs = 2000, group = false } = {}) {
  if (!proc?.pid) return Promise.resolve(true);
  const pid = proc.pid;
  const 그룹이_남았나 = () => aliveGroup(pid);
  // 우두머리가 '수확'되었는가(exitCode가 채워진다)와, group이면 그룹이 비었는가 — 둘 다여야 끝난
  // 것이다. 그룹만 보면, 우두머리가 죽었으나 아직 좀비로 남은 사이에 '끝났다'고 답하게 되어
  // 부르는 쪽의 process.kill(pid, 0)은 여전히 성공한다(좀비에게도 신호는 보내진다).
  const 우두머리가_끝났나 = () => proc.exitCode !== null || proc.signalCode !== null;
  const 끝났나 = () => 우두머리가_끝났나() && (!group || !그룹이_남았나());
  if (끝났나()) return Promise.resolve(true);
  const signal = sig => {
    try { group ? process.kill(-pid, sig) : proc.kill(sig); }
    catch { try { proc.kill(sig); } catch { /* 이미 없다 */ } }
  };
  return new Promise(resolve => {
    const timers = [];
    let watch;
    // 걸어 둔 것은 여기서 전부 걷는다 — 리스너를 남기면 이미 답을 낸 뒤에 그 콜백이 한 번 더 돌고,
    // 그동안 proc이 그 클로저에 붙들린다. '시작한 것을 남김없이 정리한다'가 이 함수의 일 전부인데,
    // 그 정리가 한 가지 모자란 채로 다음에 여기 붙일 자원의 본보기가 된다.
    const onExit = () => { if (끝났나()) done(true); };
    const done = ok => { timers.forEach(clearTimeout); clearInterval(watch); proc.off('exit', onExit); resolve(ok); };
    // exit 이벤트는 우두머리의 것뿐이라 그룹이 비었다는 뜻이 아니다 — 직접 들여다본다.
    watch = setInterval(() => { if (끝났나()) done(true); }, 50);
    proc.once('exit', onExit);
    signal('SIGTERM');
    timers.push(setTimeout(() => signal('SIGKILL'), graceMs));
    // SIGKILL로도 사라지지 않으면(좀비 등) 검사를 거기서 멈추지는 않는다 — 알리는 것은 부르는 쪽이다.
    timers.push(setTimeout(() => done(끝났나()), graceMs + 3000));
  });
}

// 검사가 제 길로 끝나지 않을 때(Ctrl-C, before()에서의 예외, 크래시)에도 띄운 것을 남기지 않는다.
// detached로 띄운 브라우저는 부모를 따라 죽지 않으므로, 그런 실행마다 headless Chrome이 한 벌씩
// 쌓인다 — after()에 무엇을 적어 두든 그 길에서는 after()가 돌지 않는다.
// procs가 함수인 이유: 등록하는 때에는 아직 띄우지 않은 것이 있다(그때그때 현재 것을 묻는다).
export function killOnExit(procs) {
  const kill = () => {
    for (const { proc, group } of procs()) {
      if (!proc?.pid) continue;
      try { group ? process.kill(-proc.pid, 'SIGKILL') : proc.kill('SIGKILL'); } catch { /* 이미 없다 */ }
    }
  };
  process.once('exit', kill);                       // 정상 종료·예외로 끝나는 길
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(sig, () => { kill(); process.exit(sig === 'SIGINT' ? 130 : 1); });
  return kill;
}

// 이미 열려 있는 탭을 다시 쓰고, 여분이 있으면 닫는다.
export async function oneTab(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pages = list.filter(t => t.type === 'page');
      for (const extra of pages.slice(1)) await fetch(`http://127.0.0.1:${port}/json/close/${extra.id}`).catch(() => {});
      if (pages[0]) return pages[0];
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) return await r.json();
    } catch { /* 아직 안 떴다 */ }
    await sleep(250);
  }
  throw new Error('Chrome의 원격 디버깅 포트가 열리지 않았습니다');
}

const SEND_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 20_000;

// 페이지에서 난 오류의 이름. CDP가 준 className이 있으면 그것이고, 없으면 메시지 '첫 줄의 앞부분'만
// 본다 — 그 뒤는 스택이라, 거기까지 훑으면 애먼 이름을 집는다.
export const errorName = e => e?.className ?? (/^([A-Za-z]*Error)\b/.exec(String(e?.message ?? ''))?.[1] ?? '');
// 기다린다고 달라지지 않는 것들 — 검사를 쓴 사람의 오타다 (아래 until).
const FATAL_ERRORS = new Set(['SyntaxError', 'ReferenceError']);

export class Page {
  constructor(ws) { this.ws = ws; this._id = 0; this.pending = new Map(); this.logs = []; this.dead = null; }

  static async open(wsUrl, { timeoutMs = OPEN_TIMEOUT_MS } = {}) {
    const ws = new WebSocket(wsUrl);
    // 여는 데에도 시간 제한을 둔다. 아래 SEND_TIMEOUT_MS와 onclose는 '이미 열린 소켓'만 지켜 주므로,
    // 포트는 답하는데 손짓이 끝나지 않는 브라우저(죽어 가는 중 등)를 만나면 이 await가 영영 풀리지
    // 않는다 — node:test에는 기본 시간 제한이 없어 검사가 실패도 아니고 끝나지도 않는다.
    // 이 파일의 다른 기다림(vite·포트·탭)이 모두 제한을 두는 것과 같은 이유다.
    // 거절할 때는 소켓을 닫고 나간다. 열린 채로 두면 그 손잡이 하나가 node를 끝나지 못하게 붙잡아,
    // 시간 제한을 두기 전과 똑같이 검사가 실패도 아니고 끝나지도 않는다(부르는 쪽의 after()는
    // page를 받지 못했으므로 닫아 줄 소켓을 알지 못한다).
    await new Promise((res, rej) => {
      let timer;
      const 실패 = why => { clearTimeout(timer); try { ws.close(); } catch { /* 이미 닫혔다 */ } rej(new Error(why)); };
      timer = setTimeout(() => 실패(`브라우저가 ${timeoutMs}ms 안에 연결을 받아 주지 않았습니다`), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => 실패('ws 연결에 오류가 났습니다');
      ws.onclose = () => 실패('ws 연결이 열리기도 전에 닫혔습니다');
    });
    const p = new Page(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) {
        const { res, rej } = p.pending.get(m.id);
        p.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        p.logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        // React는 렌더의 문제를 던지지 않고 console.error로 말한다(중첩 앵커·빠진 key·경계가 잡은
        // 오류). 그것을 듣지 않으면 '콘솔에 아무것도 오르지 않는다'는 검사가 아무것도 보지 않는다.
        p.logs.push(`console.${m.params.type}: ${m.params.args.map(a => a.description ?? String(a.value ?? a.type)).join(' ')}`);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        // 브라우저가 스스로 내는 오류(CSP 위반·불러오지 못한 자원)는 console API를 거치지 않으므로
        // Runtime.consoleAPICalled에는 오르지 않는다. 그것을 듣지 않으면 index.html의 img-src
        // 방어선이 실제로 걸려도 검사는 아무것도 보지 못한다(확인: 그때 page.logs는 비어 있었다).
        // 어느 자원이었는지까지 남긴다 — 'Failed to load resource'만 남기면 무엇이 막힌 것인지
        // 알 수 없고, 일부러 낸 줄을 가려내야 하는 쪽(ui.test.mjs)도 그것을 집을 수 없다.
        p.logs.push(`${m.params.entry.source}: ${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
      }
    };
    // 소켓이 끊기면 기다리던 요청은 영영 답을 받지 못한다 — node:test에는 기본 시간 제한이 없어
    // 그대로 두면 검사가 실패도 아니고 끝나지도 않는다(CI에서는 작업 시간을 통째로 태운다).
    const fail = why => {
      p.dead ??= new Error(why);
      for (const { rej } of p.pending.values()) rej(p.dead);
      p.pending.clear();
    };
    ws.onclose = () => fail('브라우저와의 연결이 끊겼습니다');
    ws.onerror = () => fail('브라우저와의 연결에 오류가 났습니다');
    // 여기서부터는 소켓이 열려 있다 — 아래 셋 중 하나라도 실패하면 그 손잡이를 놓고 나간다.
    // 위 손짓 단계에서 닫는 것과 같은 이유이고, 이쪽이 실제로 더 흔한 길이다: 포트도 손짓도 끝냈는데
    // CDP가 답하지 않거나 오류로 답하는 브라우저(탭이 방금 닫혔거나 죽어 가는 중)가 그 모양이다.
    // 열린 채로 두면 그 손잡이 하나가 node를 끝나지 못하게 붙잡아, 검사가 실패도 아니고 끝나지도
    // 않는다 — 부르는 쪽의 after()는 page를 받지 못했으므로 닫아 줄 소켓을 알지 못한다.
    // (확인: 손짓만 끝내고 Page.enable에 오류로 답하는 서버를 세우니 거절은 곧바로 왔는데 아이
    //  프로세스는 30초 뒤에도 끝나지 않았다. 아래 test/process.test.js가 그 모양을 재현한다.)
    // close()가 닿는 데까지가 여기서 할 수 있는 전부다: 상대가 close 프레임에 답하지 않으면 소켓은
    // CLOSING에 머물고(확인: readyState 2로 계속), node의 WebSocket에는 강제로 끊을 손잡이가 없다.
    // 그 경우(멈춰 버린 브라우저)는 부르는 쪽의 after()가 브라우저를 내리면서 함께 풀린다.
    try {
      await p.send('Page.enable');
      await p.send('Runtime.enable');
      await p.send('Log.enable');
    } catch (e) {
      try { ws.close(); } catch { /* 이미 닫혔다 */ }
      throw e;
    }
    return p;
  }

  send(method, params = {}, { timeoutMs = SEND_TIMEOUT_MS } = {}) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this._id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`브라우저가 ${timeoutMs}ms 안에 답하지 않았습니다: ${method}`));
      }, timeoutMs);
      const end = fn => v => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { res: end(res), rej: end(rej) });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); rej(e); }
    });
  }

  async eval(expression, opts) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, opts);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      const e = new Error(ex?.description ?? r.exceptionDetails.text);
      // 무엇이 났는지는 CDP가 이름으로도 알려준다(className). 메시지(description)는 스택까지 담은
      // 글자라 거기서 이름을 찾으면 남의 프레임 하나에 속는다 — 아래 until이 그것으로 갈랐었다.
      e.className = ex?.className ?? null;
      throw e;
    }
    return r.result.value;
  }

  // 화면이 어떤 상태가 될 때까지 기다린다. 정해진 시간을 자는 것과 달리, 느린 컴퓨터에서 늦게
  // 서는 화면을 기다려 주고 빠른 곳에서는 곧바로 지나간다.
  async until(expression, { timeoutMs = 15_000, everyMs = 50, what = expression } = {}) {
    let last = null;
    for (const t0 = Date.now(); ;) {
      let ok = false;
      // 한 번의 평가도 남은 예산 안에서만 기다린다. 기본값(SEND_TIMEOUT_MS)에 맡기면 마지막 평가
      // 하나가 예산을 통째로 넘겨, 15초라고 적힌 기다림이 35초 만에 '시간 안에 이루어지지 않았다'고
      // 말한다 — 그 말이 늦게 나오는 만큼 무엇이 멈춘 것인지도 흐려진다.
      const 남은 = Math.max(500, timeoutMs - (Date.now() - t0));
      try { ok = await this.eval(`!!(${expression})`, { timeoutMs: 남은 }); }
      catch (e) {
        // 화면이 바뀌는 중에는 평가가 실패한다 — 그것만 넘긴다. 식 자체가 틀린 것까지 함께 삼키면
        // 15초를 기다린 끝에 애먼 앱을 탓하는 말이 나온다. 넘긴 오류도 마지막에 함께 말한다.
        //   못 읽는 식(SyntaxError)과 없는 이름(ReferenceError)은 기다린다고 달라지지 않는다 —
        //   둘 다 검사를 쓴 사람의 오타다. TypeError는 삼킨다: 화면이 서기 전의 null을 만지는 것은
        //   지나가는 일이라 그 다음 폴링에서 풀린다(document.querySelector('.chat').scrollTop 등).
        //   가르는 것은 오류의 '이름'이다(errorName). 메시지 전체에서 그 글자를 찾으면 스택에 섞인
        //   남의 이름 하나로 — 번들 모듈 이름, 앱이 낸 문자열 — 지나가는 TypeError가 치명이 되어,
        //   통과했을 검사가 애먼 말과 함께 죽는다.
        if (this.dead || FATAL_ERRORS.has(errorName(e))) throw e;
        last = e;
      }
      if (ok) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`시간 안에 이루어지지 않았습니다: ${what}${last ? ` (마지막 오류: ${last.message})` : ''}`);
      await sleep(everyMs);
    }
  }

  // 화면을 띄우고 앱이 실제로 설 때까지 기다린다. 시간만 재고 지나가면, 의존성을 다시 묶느라
  // vite가 한 번 더 새로 고치는 첫 실행에서 아직 없는 요소를 만지다 엉뚱한 오류로 죽는다.
  //
  // 떠나는 문서에 표시를 하나 남긴다. 그것이 없으면 아래 기다림은 '아직 떠 있는 이전 화면'을 보고
  // 첫 폴링에서 참이 되어 옮겨 가기도 전에 돌아온다 — 같은 요소(.chip 등)가 두 화면에 다 있으면
  // 시간만 재던 때와 똑같이, 곧 사라질 문서를 만지게 된다.
  async goto(url, ready = '.chat') {
    await this.eval('window.__떠나는중 = true').catch(() => { /* 아직 아무 문서도 없다 */ });
    await this.send('Page.navigate', { url });
    // 선택자는 JSON.stringify로 넣는다 — 따옴표를 직접 붙이면 a[href='…'] 같은 선택자가 페이지
    // 안에서 문법 오류가 되어, 기다리는 대신 그 자리에서 낯선 SyntaxError로 죽는다.
    await this.until(`!window.__떠나는중 && document.readyState !== 'loading' && document.querySelector(${JSON.stringify(ready)})`,
      { what: `새 화면이 서기(${ready})` });
  }

  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await sleep(350);
  }

  async touchMode(on) {
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: on, ...(on ? { maxTouchPoints: 5 } : {}) });
  }

  async media(media) { await this.send('Emulation.setEmulatedMedia', { media }); await sleep(250); }

  async wheel(x, y, deltaY, deltaX = 0, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers, pointerType: 'mouse' });
    await sleep(120);
  }

  async key(key, code = key, vk = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }

  // 누르고 → 놓는다. move는 '클릭 중의 손떨림'을 흉내 낸다(그것이 따라가기를 끊어서는 안 된다).
  async press(x, y, { move = 0 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    if (move) {
      for (let i = 1; i <= 5; i++) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (move * i) / 5, y, button: 'left', buttons: 1 });
        await sleep(16);
      }
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + move, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(80);
  }
}

// 대화의 자리를 한 덩어리로 읽는다. rest는 '바닥까지 남은 거리' — 따라가기의 성패가 이 값이다.
export const STATE = `(() => {
  const el = document.querySelector('.chat');
  if (!el) return null;
  return {
    top: Math.round(el.scrollTop),
    h: Math.round(el.scrollHeight),
    ch: Math.round(el.clientHeight),
    rest: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
  };
})()`;
