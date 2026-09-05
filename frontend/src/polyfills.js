// 빌드 타깃(vite.config.js: chrome87·safari14 등) 안의 브라우저에 없는 런타임 API를 채운다.
//
// vite(esbuild)는 문법만 그 타깃으로 낮출 뿐 런타임 API는 채워 주지 않는다 — App.jsx가 AbortSignal.timeout
// 대신 AbortController를 쓰는 이유와 같다. 그런데 의존성은 그 사정을 모른다: react-markdown(hast-util-to-jsx-runtime)과
// recharts가 Object.hasOwn(Chrome 93·Safari 15.4부터)을 렌더 경로에서 부른다. 그 API가 없는 브라우저에서는
// <ReactMarkdown>이 렌더 도중에 던지고, 말풍선 경계(App.jsx Boundary)가 그것을 잡아 '이 답변을 그리지 못했습니다 —
// 원문을 그대로 보입니다'로 바꾼다 — 답변마다, 표도 차트도 실행 과정 패널도 없이(실측: Object.hasOwn을 지운 Chrome에서
// 그렇게 됐다). 오류로는 콘솔에만 남고, 지원한다고 적어 둔 브라우저에서 화면이 통째로 퇴화한다.
//
// 그래서 진입점(main.jsx)이 무엇보다 먼저 이 파일을 읽는다. 있는 브라우저에서는 아무 일도 하지 않는다.
// 명세(ECMA-262 Object.hasOwn)대로: 대상은 객체로 바꾸되 null·undefined는 던지고, 키는 프로퍼티 키로 바꾼다.
// 상속받은 프로퍼티는 false다 — hasOwnProperty를 프로토타입에서 직접 부르므로 대상이 그 이름을 덮어써도(모델이 쓴
// 열 이름 'hasOwnProperty' 같은 것) 흔들리지 않는다.
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    value: function hasOwn(target, key) {
      if (target === null || target === undefined) throw new TypeError('Object.hasOwn called on null or undefined');
      return Object.prototype.hasOwnProperty.call(Object(target), key);
    },
    writable: true, configurable: true, enumerable: false,
  });
}
