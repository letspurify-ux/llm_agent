// 답변 미리보기 — 서버가 흘려보내는 답변 조각(answer_delta)을 화면에 그리기 전에 손보는 순수 함수.
// 최종 답변은 done이 다시 준다(App.jsx). 미리보기는 '지금까지 온 글자'라 세 종류의 블록이 아직 성립하지 않는다:
//   ```chart · ```table — 서버가 답이 끝난 뒤 조회 결과로 채우는 참조라 조각 안에는 설정 줄뿐이다
//   ```mermaid — 절반만 온 그림은 문법 오류라 화면에 코드 원문이 보인다
// 그래서 세 종류의 펜스(닫힌 것도, 아직 안 닫힌 마지막 것도)를 자리 표시 한 줄로 바꾼다. 나머지 markdown은 그대로
// 그린다 — 반쯤 온 표나 목록은 그 자체로 읽을 수 있다.
// App.jsx가 아니라 여기 있는 이유는 chart.js·trace.js와 같다: 순수 함수라 node:test가 붙는다.
export const PLACEHOLDER = '_(표·차트를 준비하고 있습니다)_';

// 닫힌 펜스 — chart.js CHART_FENCE_RE와 같은 모양, 언어만 셋 중 하나다.
const CLOSED_RE = /^([ \t]*)((`|~)\3{2,})[ \t]*(?:chart|table|mermaid)(?:[ \t]+[^\r\n]*)?\r?\n(?:[\s\S]*?\r?\n)??[ \t]*\2\3*[ \t]*\r?$/gim;
// 아직 닫히지 않은 마지막 펜스 — 닫힌 것을 먼저 바꾼 뒤에 남는 것이 이것이다.
// 여는 줄의 개행을 요구하지 않는다: 조각은 아무 데서나 끊기므로 모든 블록이 '```chart'까지만 온 순간을
// 반드시 지난다. 그 순간에 이 규칙이 걸리지 않으면 한 프레임 동안 빈 차트 상자나 그림의 원문이 보인다.
const OPEN_TAIL_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(?:chart|table|mermaid)\b[\s\S]*$/im;

export function previewMarkdown(text) {
  return String(text ?? '')
    .replace(CLOSED_RE, (_, indent) => `${indent}${PLACEHOLDER}`)
    .replace(OPEN_TAIL_RE, (_, indent) => `${indent}${PLACEHOLDER}`);
}
