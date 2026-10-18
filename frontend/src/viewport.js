// 화면 키보드가 가린 만큼 앱을 줄여 보이는 자리에 맞춘다.
// iOS Safari(그리고 Chrome 108 이후의 Android)는 키보드가 떠도 레이아웃 뷰포트를 줄이지 않는다 —
// 줄어드는 것은 visual viewport뿐이다. 그래서 height: 100%(=레이아웃 뷰포트)인 .app은 그대로
// 키보드 뒤까지 뻗는다. dvh도 키보드는 셈하지 않는다(주소창만 센다). 보이는 높이를 아는 것은
// visualViewport뿐이다.
//
// 높이만 줄여서는 안 된다: iOS는 입력창이 키보드에 가려지지 않게 보이는 칸을 키보드 높이만큼 아래로
// 옮긴다(실측: offsetTop·scrollY 272). 높이만 줄인 앱은 맨 위에 붙은 채 화면 위로 밀려나고 보이는 칸의
// 아래는 빈 바탕이 된다. 브라우저가 옮긴 것을 scrollTo로 되돌리며 다투지 않고, 앱을 옮겨진 칸에
// 고정해 따라가게 한다(index.html의 html.keyboard-open .app — top은 --app-top, 높이는 --app-height).
//
// 키보드가 가릴 때만 건다. 그 밖에는 지워 CSS의 100%로 돌아간다. 손가락으로 확대한 상태도 건드리지
// 않는다: 그때의 visualViewport는 확대된 일부라 높이도 offsetTop도 키보드와 무관하다 — 그것을 따르면
// 확대할 때마다 앱이 쪼그라들고 손으로 옮겨 보는 자리를 앱이 쫓아다닌다.
// 확대는 scale이 아니라 폭으로 알아본다(실측, iPhone): Safari의 페이지 확대(가가 → 115%)를 켜면
// 손가락을 대지 않아도 scale이 1.15로 나온다 — 그때 높이·offsetTop은 그대로 CSS px이고 폭도 줄지 않는다.
// 손가락 확대만 보이는 폭을 레이아웃 뷰포트보다 좁힌다. 키보드는 폭을 건드리지 않는다.
export function fitToVisualViewport(win = window) {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const root = win.document.documentElement;
  const release = () => {
    root.classList.remove('keyboard-open');
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--app-top');
  };
  const sync = () => {
    // 견줄 것은 innerHeight가 아니라 루트의 clientWidth·clientHeight다 — 그것이 height: 100%가 가리키는
    // 레이아웃 뷰포트이고(루트에서는 CSS 높이와 무관하게 뷰포트를 돌려준다), iOS의 innerHeight는 키보드가
    // 뜨면 보이는 높이로 따라 줄어 견줄 기준이 되지 못한다(실측: 619 → 347). 1px 미만의 차이는 반올림 오차다.
    const zoomed = vv.width < root.clientWidth - 1;
    if (!zoomed && vv.height < root.clientHeight - 1) {
      root.style.setProperty('--app-height', `${vv.height}px`);
      root.style.setProperty('--app-top', `${vv.offsetTop}px`);
      root.classList.add('keyboard-open');
    } else {
      release();
    }
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
    release();
  };
}
