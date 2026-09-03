// 답변 markdown 속 주소를 어떻게 다룰지의 판정. 그리는 쪽(App.jsx의 NewTabLink·AltImage)에서 갈라
// 놓은 이유는 chart.js·trace.js와 같다: JSX가 없는 순수 함수라 node:test로 회귀 테스트가 붙는다.
//
// 여기서 지키는 것은 '모델이 쓴 글자가 곧 화면에 들어가는 자리'의 규칙이고, 깨져도 오류로는 보이지
// 않는다 — 링크가 같은 탭에서 열려 대화가 통째로 사라지거나, 주소 하나가 사용자가 누르기도 전에
// 바깥으로 나가는 요청이 된다.
import { defaultUrlTransform } from 'react-markdown';

// react-markdown이 주소를 손보는 규칙. 링크(href)는 기본 규칙 그대로 둔다 — javascript: 같은 주소를
// 빈 문자열로 바꿔 주고, 빈 href는 NewTabLink가 글자로만 남긴다.
// 그림(<img>의 src)만 원문 그대로 받는다. 기본 규칙은 http(s)·mailto가 아닌 주소를 통째로 지우는데,
// 그림을 <img>로 만들지 않는 이 화면에서는(AltImage) 그 값이 '무엇을 가리키는가'를 보여줄 유일한
// 단서다 — 지워지면 data:·tel: 그림이 주소 없는 '🖼 이미지' 한 줄로 남아, 무엇을 열지 않았는지조차
// 알 수 없다. 여는 것은 여전히 아래 imageKind가 http(s)와 상대 경로로 좁힌다.
export const mdUrlTransform = (url, key, node) =>
  (key === 'src' && node?.tagName === 'img' ? url : defaultUrlTransform(url));

// 브라우저가 주소를 읽기 전에 걷어내는 것(URL 표준). 앞뒤의 제어문자·공백은 잘리고, 탭·줄바꿈은
// 어디에 있든 빠진다 — 걷어낸 뒤에 무엇이 되는지가 실제로 열리는 주소다.
// 지금 파이프라인에서는 여기 닿기 전에 micromark가 그런 글자를 %09처럼 바꿔 두므로 대개는 할 일이
// 없다. 그래도 걷어내는 이유: 그림의 src는 mdUrlTransform이 원문 그대로 넘기고 아래 imageKind가
// 유일한 관문이라, 인코딩을 거치지 않은 값이 한 번이라도 들어오면 '\x01javascript:…'가 브라우저에서
// 앞이 잘려 살아난다(확인: new URL('\x01javascript:alert(1)', base) → javascript:alert(1)).
export const cleanUrl = s => (typeof s === 'string'
  ? s.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '').replace(/[\u0000-\u0020]+$/, '')
  : '');

// 페이지 안 앵커인가. 이것만 제자리에서 연다 — 나머지는 새 탭이다(같은 탭에서 열리면 이력이
// 메모리에만 있는 이 화면에서는 대화가 사라진다).
// 판정은 걷어낸 값으로 한다. 아래 imageKind가 이미 그렇게 하므로, 여기서만 원문을 보면 같은 규칙이
// 부르는 자리마다 다르게 답한다 — 브라우저가 같은 앵커로 읽는 주소를 두고 그림은 제자리에서,
// 링크는 새 탭에서 열게 된다(대화 없는 앱이 한 벌 더 뜬다).
export const isInPage = href => cleanUrl(href).startsWith('#');

// 링크에 얹을 속성. noopener는 새 탭이 이 창(window.opener)을 만지지 못하게, noreferrer는 사내 주소가
// 링크 대상에 referer로 새지 않게 한다.
export const linkAttrs = href => (isInPage(href) ? {} : { target: '_blank', rel: 'noopener noreferrer' });

// 그림(![글자](주소))을 어떻게 남길지: 'link'(새 탭) · 'inpage'(제자리) · 'text'(주소만 글자로).
// 어떤 경우에도 <img>는 만들지 않는다 — 그것을 만들면 브라우저가 주소를 사용자가 누르기도 전에
// 부른다. 이 앱의 답변에 그림이 실릴 자리도 없다(차트도 흐름도도 우리가 그린다).
//   링크로 여는 것은 http(s)와 주소만 적힌 상대 경로뿐이다. mailto:·tel:·data: 같은 방식은 그림
//   자리에 올 것이 아니고, '//호스트'와 그 역슬래시 변형은 콜백 없이 바깥으로 나가는 주소다.
//   링크 안에서는(inLink) <a>를 또 열 수 없다 — 중첩 앵커는 바깥 링크를 누를 수 없게 만든다.
// 판정은 걷어낸 값(cleanUrl)으로 한다 — 부르는 쪽도 그 값을 href에 써야 판정과 실제가 갈리지 않는다.
export function imageKind(src, inLink = false) {
  const s = cleanUrl(src);
  if (s === '' || inLink) return 'text';
  // 브라우저는 특별한 방식(http 등)에서 \ 를 / 로 읽는다 — '//호스트'의 변형을 함께 막는다.
  if (/^[/\\]{2}/.test(s)) return 'text';
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(s);
  if (scheme && !/^https?:$/i.test(scheme[0])) return 'text';
  return s.startsWith('#') ? 'inpage' : 'link';   // s는 이미 걷어낸 값이다 (isInPage와 같은 판정)
}

// 그리는 자리가 받아야 하는 것: 무엇으로 남길지(kind)와 그때 열 주소(url)·얹을 속성(attrs).
// '걷어낸 값으로 판정하고 그 값을 href에 쓴다'를 부르는 쪽이 기억해야 하는 규칙으로 두면, 그리는
// 자리가 하나 늘 때마다 다시 갈릴 수 있다 — 실제로 그림 자리와 링크 자리가 그렇게 갈려 있었고,
// 그 어긋남은 브라우저에서만 보인다(판정은 '제자리'인데 붙은 속성은 새 탭). 두 값을 함께 내주면
// 어긋난 짝을 만들 수가 없다.
export function imageTarget(src, inLink = false) {
  const url = cleanUrl(src);
  return { url, kind: imageKind(url, inLink), attrs: linkAttrs(url) };
}

// 링크 한 자리도 같다. url이 비면 <a>를 만들지 않는 것은 부르는 쪽이 정한다 — 빈 href는 '현재
// 문서'라 누르면 페이지가 다시 읽혀 대화가 사라진다.
export function linkTarget(href) {
  const url = cleanUrl(href);
  return { url, attrs: linkAttrs(url) };
}
