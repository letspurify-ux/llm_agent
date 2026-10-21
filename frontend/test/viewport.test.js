// 화면 키보드가 가린 만큼 앱 높이를 줄이는 것(viewport.js) 회귀 테스트 — 실행: npm test (frontend/)
//
// 진짜 키보드는 headless Chrome으로 띄울 수 없다(iOS의 visualViewport 동작은 데스크톱에 없다). 그래서
// 브라우저가 알려 주는 값(visualViewport의 height·scale·offsetTop, 루트의 clientHeight)을 손으로 주고
// 그때 앱이 고정되는 자리(top·높이)만 본다. 그 값이 화면에서 앱을 옮기는지는 Chrome에서 따로 쟀다.
import { test } from 'node:test';
import assert from 'node:assert';
import { fitToVisualViewport } from '../src/viewport.js';

function fakeWindow({ layout = 800, layoutWidth = 390, height = 800, width = 390, scale = 1, offsetTop = 0, focused = 'TEXTAREA' } = {}) {
  const props = new Map();
  const classes = new Set();
  const listeners = { resize: new Set(), scroll: new Set(), focusin: new Set(), focusout: new Set(), winresize: new Set(), winscroll: new Set() };
  const vv = {
    height, width, scale, offsetTop,
    addEventListener: (t, f) => listeners[t].add(f),
    removeEventListener: (t, f) => listeners[t].delete(f),
  };
  // 타이머는 손으로 돌린다(flush) — 초점이 빠진 뒤 몇 번 더 읽는 것을 시각 없이 본다.
  const timers = new Map();
  let nextTimer = 1;
  const document = {
    activeElement: focused ? { tagName: focused } : null,
    addEventListener: (t, f) => listeners[t].add(f),
    removeEventListener: (t, f) => listeners[t].delete(f),
    documentElement: {
      clientHeight: layout, clientWidth: layoutWidth,
      classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
    },
  };
  const win = {
    visualViewport: vv,
    document,
    scrollY: 0,
    scrollTo(x, y) { this.scrollY = y; vv.offsetTop = y; },
    addEventListener: (t, f) => listeners['win' + t].add(f),
    removeEventListener: (t, f) => listeners['win' + t].delete(f),
    setTimeout: (f) => { const id = nextTimer++; timers.set(id, f); return id; },
    clearTimeout: id => { timers.delete(id); },
  };
  const fire = (type, change) => { Object.assign(vv, change); for (const f of listeners[type]) f(); };
  const focus = tag => {
    for (const f of listeners.focusout) f();
    document.activeElement = tag ? { tagName: tag } : null;
    if (tag) for (const f of listeners.focusin) f();
  };
  const flush = () => { const fs = [...timers.values()]; timers.clear(); fs.forEach(f => f()); };
  const pinned = () => classes.has('keyboard-open')
    ? { top: props.get('--app-top'), height: props.get('--app-height') }
    : (props.size ? { leftover: [...props.keys()] } : null);
  return { win, listeners, timers, fire, focus, flush, pinned };
}

test('키보드가 없으면 아무것도 걸지 않는다 — CSS의 100%가 그대로다', () => {
  const { win, pinned } = fakeWindow();
  fitToVisualViewport(win);
  assert.equal(pinned(), null);
});

test('키보드가 뜨면 옮겨진 보이는 칸에 앱을 고정하고, 내려가면 푼다', () => {
  // 실측(iPhone): iOS는 입력창을 보이려고 보이는 칸을 키보드 높이만큼 아래로 옮긴다.
  const { win, fire, pinned } = fakeWindow({ layout: 760 });
  fitToVisualViewport(win);
  fire('resize', { height: 420 });
  assert.deepEqual(pinned(), { top: '0px', height: '420px' });
  fire('scroll', { offsetTop: 340 });
  assert.deepEqual(pinned(), { top: '340px', height: '420px' });
  fire('resize', { height: 760, offsetTop: 0 });
  assert.equal(pinned(), null);
});

test('Safari 페이지 확대(115%)에서도 키보드를 알아본다 — scale만 1이 아니다', () => {
  // 실측(iPhone, iOS 18.7 Safari 26.6, 가가 → 115%): 키보드 전 h619 scale 1.15, 뒤 h347 offsetTop 272.
  const { win, fire, pinned } = fakeWindow({ layout: 619, layoutWidth: 342, height: 619, width: 342, scale: 1.15 });
  fitToVisualViewport(win);
  assert.equal(pinned(), null);
  fire('resize', { height: 347 });
  fire('scroll', { offsetTop: 272 });
  assert.deepEqual(pinned(), { top: '272px', height: '347px' });
});

test('손가락으로 확대한 것은 키보드가 아니다 — 걸지 않는다', () => {
  const { win, fire, pinned } = fakeWindow({ layout: 800 });
  fitToVisualViewport(win);
  fire('resize', { height: 800 / 2.5, width: 390 / 2.5, scale: 2.5 });
  fire('scroll', { offsetTop: 200 });
  assert.equal(pinned(), null);
});

test('확대한 채로 키보드가 떠도 손으로 옮겨 보는 자리를 앱이 쫓지 않는다', () => {
  const { win, fire, pinned } = fakeWindow({ layout: 800 });
  fitToVisualViewport(win);
  fire('resize', { height: 400 / 2, width: 390 / 2, scale: 2, offsetTop: 150 });
  assert.equal(pinned(), null);
});

test('키보드가 뜬 채 손가락으로 확대하면 풀되 옮겨 보는 자리는 그대로 둔다', () => {
  const { win, fire, pinned } = fakeWindow({ layout: 800 });
  fitToVisualViewport(win);
  fire('resize', { height: 400, offsetTop: 300 });
  win.scrollY = 300;
  fire('resize', { height: 200, width: 195, scale: 2, offsetTop: 420 });
  assert.equal(pinned(), null);
  assert.equal(win.scrollY, 300);
});

test('visualViewport가 없는 브라우저에서는 아무것도 하지 않는다', () => {
  const stop = fitToVisualViewport({ visualViewport: undefined });
  assert.equal(typeof stop, 'function');
  stop();
});

test('정리하면 듣기를 떼고 건 것을 지운다', () => {
  const { win, listeners, timers, fire, focus, pinned } = fakeWindow({ layout: 760 });
  const stop = fitToVisualViewport(win);
  fire('resize', { height: 400, offsetTop: 300 });
  focus('INPUT');
  stop();
  assert.equal([...Object.values(listeners)].reduce((n, l) => n + l.size, 0), 0);
  assert.equal(timers.size, 0);
  assert.equal(pinned(), null);
});

test('키보드를 닫았는데 보이는 칸의 값이 그대로 남아도 초점이 빠지면 푼다', () => {
  // 실기기(iPhone, Safari 26): 키보드를 닫자 앱이 키보드 높이(화면 절반)에 고정된 채 남아 대화가 보이지
  // 않았다 — 보이는 칸이 마지막 resize 없이(또는 옛 값으로) 남으면 sync를 다시 부르는 것이 없었다.
  const { win, fire, focus, flush, pinned } = fakeWindow({ layout: 619 });
  fitToVisualViewport(win);
  fire('resize', { height: 347 });
  fire('scroll', { offsetTop: 272 });
  win.scrollY = 272;
  assert.deepEqual(pinned(), { top: '272px', height: '347px' });
  focus(null); // 키보드의 완료·바깥 누르기 = 입력창에서 초점이 빠진다. visualViewport는 그대로 347
  flush();
  assert.equal(pinned(), null);
  assert.equal(win.scrollY, 0, '키보드가 옮겨 둔 페이지 스크롤도 되돌린다');
});

test('초점이 오간 뒤 이벤트 없이 바뀐 보이는 칸도 잠시 다시 읽어 따라간다', () => {
  const { win, focus, flush, pinned } = fakeWindow({ layout: 619, focused: null });
  fitToVisualViewport(win);
  focus('TEXTAREA');
  // 키보드가 올라와 값은 바뀌었는데 resize가 오지 않았다
  Object.assign(win.visualViewport, { height: 347, offsetTop: 272 });
  assert.equal(pinned(), null, '아직 아무도 다시 읽지 않았다');
  flush();
  assert.deepEqual(pinned(), { top: '272px', height: '347px' });
});

test('보이는 칸만 옮겨진 채 남아도(페이지 스크롤은 0) 풀 때 되돌린다', () => {
  // 그려진 자리와 누르는 자리가 어긋나 아무것도 눌리지 않던 상태 — 스크롤을 다시 놓아 맞춘다.
  const { win, fire, focus, flush, pinned } = fakeWindow({ layout: 619 });
  let scrolled = 0;
  const to = win.scrollTo.bind(win);
  win.scrollTo = (x, y) => { scrolled++; to(x, y); };
  fitToVisualViewport(win);
  fire('resize', { height: 347, offsetTop: 272 });
  assert.deepEqual(pinned(), { top: '272px', height: '347px' });
  focus(null);
  flush();
  assert.equal(pinned(), null);
  assert.equal(scrolled, 1);
  assert.equal(win.visualViewport.offsetTop, 0);
});

test('창의 resize·scroll만 와도 다시 본다', () => {
  const { win, listeners, fire, pinned } = fakeWindow({ layout: 619 });
  fitToVisualViewport(win);
  fire('resize', { height: 347 });
  Object.assign(win.visualViewport, { height: 619 });
  for (const f of listeners.winscroll) f();
  assert.equal(pinned(), null);
});

test('다른 입력칸으로 초점이 옮겨 가는 동안에는 풀지 않는다', () => {
  const { win, fire, focus, flush, pinned } = fakeWindow({ layout: 619 });
  fitToVisualViewport(win);
  fire('resize', { height: 347 });
  focus('INPUT');
  flush();
  assert.deepEqual(pinned(), { top: '0px', height: '347px' });
  assert.equal(win.scrollY, 0);
});

test('글을 쓰는 칸에 초점이 없으면 보이는 칸이 작아도 키보드로 보지 않는다', () => {
  // 화면 아래에 떠 있는 도구 막대 같은 것이 보이는 칸을 줄여도 앱을 거기 고정하지 않는다.
  const { win, fire, pinned } = fakeWindow({ layout: 760, focused: null });
  fitToVisualViewport(win);
  fire('resize', { height: 700 });
  assert.equal(pinned(), null);
});
