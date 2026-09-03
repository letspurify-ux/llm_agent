// 답변 markdown 속 주소를 어떻게 다룰지의 판정. 그리는 쪽(App.jsx의 NewTabLink·AltImage)에서 갈라
// 놓은 이유는 chart.js·trace.js와 같다: JSX가 없는 순수 함수라 node:test로 회귀 테스트가 붙는다.
//
// 여기서 지키는 것은 '모델이 쓴 글자가 곧 화면에 들어가는 자리'의 규칙이고, 깨져도 오류로는 보이지
// 않는다 — 링크가 같은 탭에서 열려 대화가 통째로 사라지거나, 주소 하나가 사용자가 누르기도 전에
// 바깥으로 나가는 요청이 된다.

// 페이지 안 앵커인가. 이것만 제자리에서 연다 — 나머지는 새 탭이다(같은 탭에서 열리면 이력이
// 메모리에만 있는 이 화면에서는 대화가 사라진다).
export const isInPage = href => typeof href === 'string' && href.startsWith('#');

// 링크에 얹을 속성. noopener는 새 탭이 이 창(window.opener)을 만지지 못하게, noreferrer는 사내 주소가
// 링크 대상에 referer로 새지 않게 한다.
export const linkAttrs = href => (isInPage(href) ? {} : { target: '_blank', rel: 'noopener noreferrer' });

// 그림(![글자](주소))을 어떻게 남길지: 'link'(새 탭) · 'inpage'(제자리) · 'text'(주소만 글자로).
// 어떤 경우에도 <img>는 만들지 않는다 — 그것을 만들면 브라우저가 주소를 사용자가 누르기도 전에
// 부른다. 이 앱의 답변에 그림이 실릴 자리도 없다(차트도 흐름도도 우리가 그린다).
//   링크로 여는 것은 http(s)와 주소만 적힌 상대 경로뿐이다. mailto:·tel:·data: 같은 방식은 그림
//   자리에 올 것이 아니고, '//호스트'와 그 역슬래시 변형은 콜백 없이 바깥으로 나가는 주소다.
//   링크 안에서는(inLink) <a>를 또 열 수 없다 — 중첩 앵커는 바깥 링크를 누를 수 없게 만든다.
export function imageKind(src, inLink = false) {
  if (typeof src !== 'string' || src === '' || inLink) return 'text';
  // 브라우저는 특별한 방식(http 등)에서 \ 를 / 로 읽는다 — '//호스트'의 변형을 함께 막는다.
  if (/^[/\\]{2}/.test(src)) return 'text';
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(src);
  if (scheme && !/^https?:$/i.test(scheme[0])) return 'text';
  return isInPage(src) ? 'inpage' : 'link';
}
