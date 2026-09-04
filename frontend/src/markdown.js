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

// 각주([^1])를 그릴 때 붙는 글자. remark-rehype가 만드는 것이고 기본값은 영어다 — 한국어 화면에
// 'Footnotes'라는 제목과 'Back to reference 1'이라는 스크린리더 글자가 그대로 나간다(실측: 말풍선이
// '본문에 각주가 있습니다1. Footnotes 각주 내용입니다. ↩'로 보였다). 오류는 나지 않는다.
// 제목의 클래스도 함께 비운다. 기본값은 sr-only인데(화면에서 감추고 스크린리더에만 읽히라는 뜻),
// 이 화면에는 그런 규칙이 없어 감춰지지 않는다 — 이름이 하는 말과 실제가 다른 클래스를 남겨 두면
// 언젠가 누가 .sr-only 한 줄을 더한 날 이 제목이 소리 없이 사라진다. 보이는 편이 낫다: 감추면
// 각주 묶음이 모델이 쓴 번호 목록과 구별되지 않는다. 그래서 '보이는 제목'이라고 여기서 못 박는다
// (id는 라이브러리가 늘 붙이므로 본문의 aria-describedby는 그대로 이어진다).
const FOOTNOTE_OPTIONS = Object.freeze({
  footnoteLabel: '각주',
  footnoteLabelProperties: Object.freeze({}),
  footnoteBackLabel: (i, r) => `본문으로 돌아가기 ${i + 1}${r > 1 ? `-${r}` : ''}`,
});

// <ReactMarkdown>에 걸 한 벌. 위의 urlTransform은 그림 src의 기본 검사를 걷어내므로, 그 값을 <img>로
// 만들지 않는 img 컴포넌트(App.jsx AltImage)가 반드시 함께 있어야 한다 — 둘을 따로 넘기면 짝을
// 맞추는 일이 자리마다의 기억이 되고, 새 <ReactMarkdown> 하나가 그것을 잊으면 모델이 쓴 주소가
// 곧바로 <img src>가 되어 사용자가 누르기도 전에 불려 나간다(오류로는 보이지 않는다).
// 그래서 한 객체로 묶어 내고, img가 없으면 여기서 곧바로 멈춘다.
// 각주 글자(위 FOOTNOTE_OPTIONS)도 같은 한 벌에 넣는 이유가 이것이다 — 자리마다 따로 적으면
// 새 <ReactMarkdown> 하나가 영어 제목을 그대로 내보낸다.
// 부르는 쪽은 모듈 상수로 한 번만 만든다 — 렌더마다 새 객체를 넘기면 react-markdown이 파이프라인을
// 매번 다시 조립한다(App.jsx의 플러그인 배열과 같은 이유. remarkRehypeOptions도 그 재조립의 조건이다).
export function mdProps(components) {
  if (typeof components?.img !== 'function')
    throw new Error('mdProps: img 컴포넌트가 없으면 그림 주소가 곧바로 <img src>가 된다');
  return Object.freeze({
    urlTransform: mdUrlTransform,
    remarkRehypeOptions: FOOTNOTE_OPTIONS,
    components: Object.freeze({ ...components }),
  });
}

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
// 판정은 걷어낸 값으로 한다. 한쪽만 원문을 보면 같은 규칙이 부르는 자리마다 다르게 답한다 —
// 브라우저가 같은 앵커로 읽는 주소를 두고 그림은 제자리에서, 링크는 새 탭에서 열게 된다
// (대화 없는 앱이 한 벌 더 뜬다).
// '#'을 보는 자리는 아래 하나뿐이다 — 그림 쪽(걷어낸것의_종류)도 이것을 부른다. 같은 규칙을 두 벌
// 적어 두면 그중 하나를 고친 날 두 자리가 같은 주소를 다르게 판정한다.
const 걷어낸것이_앵커인가 = s => s.startsWith('#');
export const isInPage = href => 걷어낸것이_앵커인가(cleanUrl(href));

// 링크에 얹을 속성. noopener는 새 탭이 이 창(window.opener)을 만지지 못하게, noreferrer는 사내 주소가
// 링크 대상에 referer로 새지 않게 한다.
const 걷어낸것의_속성 = s => (걷어낸것이_앵커인가(s) ? {} : { target: '_blank', rel: 'noopener noreferrer' });
export const linkAttrs = href => 걷어낸것의_속성(cleanUrl(href));

// 그림(![글자](주소))을 어떻게 남길지: 'link'(새 탭) · 'inpage'(제자리) · 'text'(주소만 글자로).
// 어떤 경우에도 <img>는 만들지 않는다 — 그것을 만들면 브라우저가 주소를 사용자가 누르기도 전에
// 부른다. 이 앱의 답변에 그림이 실릴 자리도 없다(차트도 흐름도도 우리가 그린다).
//   링크로 여는 것은 http(s)와 주소만 적힌 상대 경로뿐이다. mailto:·tel:·data: 같은 방식은 그림
//   자리에 올 것이 아니고, '//호스트'와 그 역슬래시 변형은 콜백 없이 바깥으로 나가는 주소다.
//   링크 안에서는(inLink) <a>를 또 열 수 없다 — 중첩 앵커는 바깥 링크를 누를 수 없게 만든다.
// 판정은 걷어낸 값(cleanUrl)으로 한다 — 부르는 쪽도 그 값을 href에 써야 판정과 실제가 갈리지 않는다.
// 걷어내는 일과 판정하는 일을 가른 이유: 아래 imageTarget은 하나의 주소로 kind와 attrs를 함께 내는데,
// 공개 함수들이 저마다 다시 걷어내면 같은 값에 cleanUrl이 두세 번 돈다. 지금은 그래도 답이 같지만
// (같은 값을 다시 걷어내도 그대로다) 그것은 아무도 적어 두지 않은 약속이라, cleanUrl에 그렇지 않은
// 단계가 하나 붙는 날 kind·attrs·url이 소리 없이 갈라선다 — 이 파일이 막으려던 바로 그 어긋남이다.
// 그래서 걷어내는 것은 공개 함수의 입구에서 딱 한 번이고, 아래 '걷어낸것의…'들은 이미 걷어낸 값만 받는다.
const 걷어낸것의_종류 = (s, inLink) => {
  if (s === '' || inLink) return 'text';
  // 브라우저는 특별한 방식(http 등)에서 \ 를 / 로 읽는다 — '//호스트'의 변형을 함께 막는다.
  if (/^[/\\]{2}/.test(s)) return 'text';
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(s);
  if (scheme && !/^https?:$/i.test(scheme[0])) return 'text';
  return 걷어낸것이_앵커인가(s) ? 'inpage' : 'link';
};
export const imageKind = (src, inLink = false) => 걷어낸것의_종류(cleanUrl(src), inLink);

// 그리는 자리가 받아야 하는 것: 무엇으로 남길지(kind)와 그때 열 주소(url)·얹을 속성(attrs).
// '걷어낸 값으로 판정하고 그 값을 href에 쓴다'를 부르는 쪽이 기억해야 하는 규칙으로 두면, 그리는
// 자리가 하나 늘 때마다 다시 갈릴 수 있다 — 실제로 그림 자리와 링크 자리가 그렇게 갈려 있었고,
// 그 어긋남은 브라우저에서만 보인다(판정은 '제자리'인데 붙은 속성은 새 탭). 두 값을 함께 내주면
// 어긋난 짝을 만들 수가 없다.
export function imageTarget(src, inLink = false) {
  const url = cleanUrl(src);
  return { url, kind: 걷어낸것의_종류(url, inLink), attrs: 걷어낸것의_속성(url) };
}

// 링크 한 자리도 같다. url이 비면 <a>를 만들지 않는 것은 부르는 쪽이 정한다 — 빈 href는 '현재
// 문서'라 누르면 페이지가 다시 읽혀 대화가 사라진다.
export function linkTarget(href) {
  const url = cleanUrl(href);
  return { url, attrs: 걷어낸것의_속성(url) };
}

// 흐름도 원문에 그림 노드(`A@{ img: "주소" }`)가 있는가. mermaid는 이 노드의 크기를 재려고 그리는 도중에
// 그 주소를 new Image()로 불러온다 — 사용자가 누르기도 전에, 그리고 그림이 화면에 서기도 전에 요청이
// 나간다(실측: 같은 출처 요청 1건이 먼저 나가고, 다른 출처는 CSP에 막힌 뒤에야 멈춘다). 설정으로 끄는
// 길이 없으므로 그리기 전에 원문에서 알아보고 그리지 않는다(Mermaid.jsx) — 원문 코드가 남는다. 이 화면이
// 답변의 그림을 링크로만 남기는 것(App.jsx AltImage)과 같은 규칙이다. 판정은 mermaid의 노드 속성 문법
// (`@{ … }` 안의 `img:` 키)을 본다 — 줄을 넘어 적어도, 다른 속성 뒤에 와도, 키를 따옴표로 감싸도(YAML이
// 허용한다 — `"img":`) 걸린다. 닫는 `}`를 찾아 그 안만 보지 않는다: 속성값의 따옴표 안에 `}`가 있으면
// (`label: "a } b", img: …`) 그 앞에서 멈춰 뒤의 img를 놓친다(실측: 그 둘로 요청이 나갔다). 그래서 `@{`
// 뒤에 오는 것은 어디까지든 본다. 라벨의 글자에 같은 모양이 있으면 그리지 않는 쪽으로 틀리는데, 그
// 손해는 흐름도 하나가 코드로 남는 것뿐이다.
export const mermaidLoadsImage = text => /@\s*\{[\s\S]*?["']?\bimg\b["']?\s*:/i.test(String(text ?? ''));

// 흐름도 원문의 설정 자리(지시문 `%%{…}%%`, 머리말 `---…---`)가 바깥을 부르는 CSS(url(…)·@import)를 담고
// 있는가. mermaid는 그 자리의 글자(themeCSS·fontFamily·fontSize·themeVariables)를 그대로 <style>에 넣고,
// 그리는 도중에 그 SVG를 문서에 넣어 크기를 잰다 — 그 순간 `background: url(주소)`가 요청이 된다(실측:
// 같은 출처 요청이 나갔고 다른 출처는 CSP가 막았다. 그린 뒤 <style>에서 걷어내 보았으나 요청은 이미
// 나간 뒤였다). 그래서 위 그림 노드와 같이 그리기 전에 알아보고 그리지 않는다(Mermaid.jsx). 라벨의
// 글자는 보지 않는다 — 라벨은 CSS가 아니다. 색·테마를 바꾸는 지시문은 그대로 그려진다.
export const mermaidFetchesViaStyle = text => {
  const s = String(text ?? '');
  const config = [...s.matchAll(/%%\{[\s\S]*?\}%%/g)].map(m => m[0]).join('\n')
    + '\n' + (/^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(s)?.[1] ?? '');
  return /url\s*\(|@import\b/i.test(config);
};

// react-markdown을 거치지 않은 링크(흐름도의 `click` 링크 — mermaid가 SVG 안에 <a>로 만든다). 위
// linkTarget은 href가 이미 기본 규칙(defaultUrlTransform)을 지난 것으로 알고 받으므로, 그 규칙을
// 여기서 먼저 건다 — 같은 화면의 링크가 온 길에 따라 다른 주소를 허용하면 안 된다.
// 앞뒤 공백은 기본 규칙보다 먼저 걷어낸다 — markdown의 링크는 파서가 걷어낸 주소를 기본 규칙에 넘기는데,
// 여기서는 그 단계가 없어 ' https://…'가 방식 없는 주소로 읽혀 통째로 버려진다.
export function rawLinkTarget(href) {
  return linkTarget(defaultUrlTransform(cleanUrl(href)));
}
