// 화면 키보드가 가린 만큼 앱 높이를 줄이는 것(viewport.js) 회귀 테스트 — 실행: npm test (frontend/)
//
// 진짜 키보드는 headless Chrome으로 띄울 수 없다(iOS의 visualViewport 동작은 데스크톱에 없다). 그래서
// 브라우저가 알려 주는 값(visualViewport의 height·scale·offsetTop, 루트의 clientHeight)을 손으로 주고
// 그때 앱이 고정되는 자리(top·높이)만 본다. 그 값이 화면에서 앱을 옮기는지는 Chrome에서 따로 쟀다.
import { test } from 'node:test';
import assert from 'node:assert';
import { fitToVisualViewport } from '../src/viewport.js';

function fakeWindow({ layout = 800, layoutWidth = 390, height = 800, width = 390, scale = 1, offsetTop = 0 } = {}) {
  const props = new Map();
  const classes = new Set();
  const listeners = { resize: new Set(), scroll: new Set() };
  const vv = {
    height, width, scale, offsetTop,
    addEventListener: (t, f) => listeners[t].add(f),
    removeEventListener: (t, f) => listeners[t].delete(f),
  };
  const win = {
    visualViewport: vv,
    document: { documentElement: {
      clientHeight: layout, clientWidth: layoutWidth,
      classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
    } },
  };
  const fire = (type, change) => { Object.assign(vv, change); for (const f of listeners[type]) f(); };
  const pinned = () => classes.has('keyboard-open')
    ? { top: props.get('--app-top'), height: props.get('--app-height') }
    : (props.size ? { leftover: [...props.keys()] } : null);
  return { win, listeners, fire, pinned };
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

test('visualViewport가 없는 브라우저에서는 아무것도 하지 않는다', () => {
  const stop = fitToVisualViewport({ visualViewport: undefined });
  assert.equal(typeof stop, 'function');
  stop();
});

test('정리하면 듣기를 떼고 건 것을 지운다', () => {
  const { win, listeners, fire, pinned } = fakeWindow({ layout: 760 });
  const stop = fitToVisualViewport(win);
  fire('resize', { height: 400, offsetTop: 300 });
  stop();
  assert.equal(listeners.resize.size + listeners.scroll.size, 0);
  assert.equal(pinned(), null);
});
