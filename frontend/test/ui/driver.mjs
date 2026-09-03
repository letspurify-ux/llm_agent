// UI 회귀 테스트용 최소 브라우저 드라이버. 의존성을 더하지 않으려고 CDP(Chrome DevTools Protocol)를
// 직접 쓴다 — node의 내장 WebSocket과 fetch만 있으면 된다.
//
// 탭은 하나만 쓴다. 검사를 돌릴 때마다 새 탭을 열면 브라우저가 수십 개를 안고 느려지다 멈춘다.
import { spawn } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

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

export function launchChrome({ bin, port, profile }) {
  const p = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1200,900', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--disable-features=Translate,BackForwardCache',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  p.unref();
  return p;
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

export class Page {
  constructor(ws) { this.ws = ws; this._id = 0; this.pending = new Map(); this.logs = []; }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 연결 실패')); });
    const p = new Page(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) {
        const { res, rej } = p.pending.get(m.id);
        p.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        p.logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      }
    };
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    return p;
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async goto(url) { await this.send('Page.navigate', { url }); await sleep(1200); }

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

  // 누르고 → (사이에 무슨 일이 나게 하고) → 놓는다. jitter는 '클릭 중의 손떨림'을 흉내 낸다.
  async press(x, y, { move = 0, between = null, button = 'left' } = {}) {
    const mask = button === 'right' ? 2 : 1;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: 1 });
    if (move) {
      for (let i = 1; i <= 5; i++) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (move * i) / 5, y, button, buttons: mask });
        await sleep(16);
      }
    }
    if (between) await between();
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + move, y, button, buttons: 0, clickCount: 1 });
    await sleep(80);
  }

  async touchPan(x, y, yDistance, xDistance = 0) {
    await this.send('Input.synthesizeScrollGesture', { x, y, xDistance, yDistance, gestureSourceType: 'touch', speed: 800, preventFling: true });
    await sleep(150);
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
