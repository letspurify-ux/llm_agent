// 답변 미리보기 — 서버가 흘려보내는 답변 조각(answer_delta)을 화면에 그리기 전에 손보는 순수 함수.
// 최종 답변은 done이 다시 준다(App.jsx). 미리보기는 '지금까지 온 글자'라 세 종류의 블록이 아직 성립하지 않는다:
//   ```chart · ```table — 서버가 답이 끝난 뒤 조회 결과로 채우는 참조라 조각 안에는 설정 줄뿐이다
//   ```mermaid — 절반만 온 그림은 문법 오류라 화면에 코드 원문이 보인다
// 그래서 세 종류의 펜스(닫힌 것도, 아직 안 닫힌 마지막 것도)를 자리 표시 한 줄로 바꾼다. 나머지 markdown은 그대로
// 그린다 — 반쯤 온 표나 목록은 그 자체로 읽을 수 있다.
// App.jsx가 아니라 여기 있는 이유는 chart.js·trace.js와 같다: 순수 함수라 node:test가 붙는다.
export const PLACEHOLDER = '_(표·차트를 준비하고 있습니다)_';

// 한 번만 훑는다. 앞서는 닫힌 펜스와 열린 꼬리를 정규식 둘로 바꿨는데, 닫힌 펜스 쪽이 여는 줄마다 닫는 줄을
// 끝까지 찾는 꼴이라 비용이 '여는 줄 수 × 길이'였다. 여는 줄만 되풀이하는 퇴화한 응답(temperature=0에서
// 실제로 난다 — 백엔드 파서가 '<think' 반복에서 겪은 것과 같은 부류)에서 답변 상한 안의 7,500줄이 한 번에
// 390ms였고, 미리보기는 120ms마다 자라난 전체를 다시 손보므로 스트림이 끝날 때까지 화면이 멈췄다(실측).
// 줄 단위 상태 기계는 길이에 비례한다. 규칙은 markdown의 펜스와 같다 — 여는 줄의 펜스 글자와 수를 기억하고,
// 같은 글자가 그 수 이상 놓인 빈 줄에서만 닫는다. 백틱 펜스의 여는 줄에 백틱이 더 있으면 펜스가 아니다
// (인라인 코드). 보통 코드 펜스 안의 줄은 그대로 두므로, 그 안에 적힌 '```chart'는 펜스로 보지 않는다.
// 언어 이름은 대소문자를 가리지 않는다 — 그리는 쪽(App.jsx codeOf)·이력(chart.js CHART_FENCE_RE)·서버(backend chart.js)가
// 모두 그렇고, 모델은 ```Chart 라고도 쓴다. 여기만 가리던 동안에는 ```Chart 블록이 미리보기에서 자리 표시가 아니라
// 차트로 그려져 '차트를 그리지 못했습니다: 조회 결과를 채우지 못했습니다'라는 거짓 안내가 답이 오기까지 떠 있었고,
// 반쯤 온 ```Mermaid 는 그림으로 그려져 파스 오류 경고를 콘솔에 남겼다(실측).
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const TARGET_RE = /^[ \t]*(?:chart|table|mermaid)\b/i;

export function previewMarkdown(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let open = null;   // 열린 펜스 { ch, len, indent, target }
  for (const line of lines) {
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
    const m = FENCE_RE.exec(bare);
    if (open) {
      const closes = !!m && m[2][0] === open.ch && m[2].length >= open.len && !m[3].trim();
      if (open.target) {
        // 세 종류의 블록은 줄을 버리고 자리 표시 하나로 접는다 — 닫힐 때 한 번 내보낸다
        if (closes) { out.push(`${open.indent}${PLACEHOLDER}`); open = null; }
      } else {
        out.push(line);
        if (closes) open = null;
      }
      continue;
    }
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      open = { ch: m[2][0], len: m[2].length, indent: m[1], target: TARGET_RE.test(m[3]) };
      if (!open.target) out.push(line);
      continue;
    }
    out.push(line);
  }
  // 아직 닫히지 않은 마지막 펜스도 자리 표시다. 여는 줄의 개행을 요구하지 않는다: 조각은 아무 데서나 끊기므로
  // 모든 블록이 '```chart'까지만 온 순간을 반드시 지난다. 그 순간에 걸리지 않으면 한 프레임 동안 빈 차트
  // 상자나 그림의 원문이 보인다.
  if (open?.target) out.push(`${open.indent}${PLACEHOLDER}`);
  return out.join('\n');
}
