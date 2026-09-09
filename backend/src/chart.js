// 답변의 ```chart 블록에서 `data: step N` 참조를 실제 조회 결과 표로 채운다.
//
// 모델은 조회 결과를 프롬프트에서 20행까지만 본다(MAX_RESULT_ROWS). 수백 행짜리 결과를 그리려면
// 모델이 그 값들을 답변에 옮겨 적어야 하는데, 보지 못한 행은 적을 수 없고 본 행도 옮기는 동안 값이
// 바뀐다(숫자 반올림·자릿수 누락을 실측했다). 그래서 답변에는 '몇 번째 실행'만 적게 하고, 서버가
// 손에 든 전체 행(oracle.js가 MAX_ROWS까지 정규화해 준 것)으로 여기서 표를 만든다.
//
// 스텝 번호는 프롬프트의 '실행 N' 번호와 같다 — llm-openai.js renderHistory가 history의 1-based 절대
// 인덱스로 찍으므로 여기서도 그 인덱스로 찾는다(오류·메모 항목도 번호를 차지한다). 이 둘이 어긋나면
// 모델은 자기가 본 번호를 옳게 적었는데 다른 조회의 표가 그려진다 — 조용한 오답이라 반드시 같은 규칙이어야 한다.
//
// 블록의 줄 문법(설정 줄·표 줄의 판정)은 frontend/src/chart.js splitBlock과 같다. 이쪽은 `data:` 줄을
// 표로 바꾸는 일만 하고, 그 표를 어떻게 그릴지는 프런트가 정한다.
//
// 실패는 한쪽으로만 열린다: 참조를 채우지 못하면 블록을 짧은 안내 문장으로 바꾼다 — 채우지 못한 블록을
// 그대로 두면 프런트가 설정 줄만 든 코드블록을 보여주고, 사용자는 그것이 무엇인지 알 수 없다.

import { nameKey, clipText, TRUNC_MARK, ownProp } from './constants.js';
import { columnOmissionKey } from './result.js';
import { inlineCodeSpans, codeSpanInLiteral } from '../../shared/inline-code.mjs';
import { answerSyntax } from './markdown-syntax.js';
import { decodeSerializedLines, decodeVisualizationBreaks } from '../../shared/serialized-markdown.mjs';

// 생략 안내의 출처로 판정한다. 실제 컬럼 이름이 '…'일 수 있고, 안내 이름도 행마다 다를 수 있다.
const dataKeys = row => Object.keys(row ?? {}).filter(k => k !== columnOmissionKey(row));
const dataValue = (row, key) => key === columnOmissionKey(row) ? undefined : ownProp(row, key);

// x·y·y2 지정이 없을 때 싣는 열 수. 넓은 결과(SELECT *)를 그대로 실으면 표가 화면을 넘고, 프런트도
// 시리즈 6개까지만 그린다.
export const MAX_CHART_COLS = 8;
// 셀 하나. 차트의 축 라벨·툴팁에 들어갈 값이라 프롬프트용 상한(MAX_CELL_LEN 200)보다 짧다.
export const MAX_CHART_CELL_LEN = 60;
// 블록 하나에 싣는 행 수. 프런트가 그리는 행 수(frontend/src/chart.js MAX_CHART_ROWS)와 같다 — 그 위의 행은
// 그려지지 않는 채 답변만 키운다. 조회 상한 MAX_ROWS(1000행)를 한 블록에 다 실으면 아래 총량 예산을 혼자 다 써서
// 같은 답변의 둘째 차트(다른 스텝이든, 같은 스텝의 원그래프든)가 표 없이 안내 문장만 남는 것을 실측했다.
// 조회된 행 전부는 화면 trace 패널에 있다(result.js clientTrace) — 여기의 표는 그릴 몫이지 전체를 보는 자리가 아니다.
export const MAX_CHART_BLOCK_ROWS = 100;
// 답변 하나에 채워 넣는 표의 총 글자 수. 모델 답변 상한(MAX_ANSWER_LEN)은 파싱 경계에서 이미 적용된
// 뒤라 이 양만큼은 그 위에 얹힌다 — 응답과 chat_log.answer가 그만큼 커질 수 있음을 알고 잡은 값이다.
// 행 상한이 있으니 평소(짧은 숫자 셀, 블록당 3~5k)에는 닿지 않고, 긴 글자 열을 여럿 실은 넓은 표만 여기에 걸린다.
// 예산은 채울 블록 수로 나눠 준다(아래 resolveChartData) — 먼저 온 블록이 다 쓰면 뒤 블록은 표를 잃는다.
export const MAX_CHART_INJECT_LEN = 30_000;

// 파서가 확정한 코드 노드에서 닫힌 펜스만 선택한다. 들여쓰기·인용 기호의
// 유효성은 AST가 결정하고, 치환할 때 필요한 원래 컨테이너 접두사만 보관한다.
function fencedBlocks(text, language, syntax) {
  const blocks = [];
  for (const node of syntax.codes.values()) {
    if (node.lang?.toLowerCase() !== language) continue;
    const { start, end } = node.position;
    const raw = text.slice(start.offset, end.offset);
    const open = /^(`{3,}|~{3,})/.exec(raw);
    if (!open) continue;
    const lastNewline = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r'));
    if (lastNewline < 0) continue;
    const close = /^([ \t>]*)(`{3,}|~{3,})[ \t]*$/.exec(raw.slice(lastNewline + 1));
    if (!close || close[2][0] !== open[1][0] || close[2].length < open[1].length) continue;
    // 들여쓰기가 너무 깊은 마지막 백틱은 닫는 펜스가 아니라 코드 본문이다.
    const bodyLines = node.value ? node.value.split(/\r\n?|\n/).length : 0;
    if (raw.split(/\r\n?|\n/).length < bodyLines + 2) continue;
    const index = Math.max(text.lastIndexOf('\n', start.offset - 1), text.lastIndexOf('\r', start.offset - 1)) + 1;
    const first = text.slice(index, start.offset), rest = close[1];
    const finish = end.offset + (text.startsWith('\r\n', end.offset) ? 1 : 0);
    const block = [text.slice(index, finish), '', open[1], open[1][0], node.value];
    block.index = index;
    if (first || rest) block.container = { first, rest };
    blocks.push(block);
  }
  return blocks.sort((a, b) => a.index - b.index);
}

// 표 셀 또는 독립 문단의 `chart<br>...` / `chart\n...`도 같은 데이터 계약이다.
// 일반 펜스 안의 예제와 일반 인라인 코드 안의 중첩 백틱은 건드리지 않는다.
function serializedChartBlocks(text, syntax) {
  if (!/`[ \t]*chart(?=(?:\\r)?\\n|\\?<br\s*\/?>)/i.test(text)) return [];
  const literalRanges = syntax.literals;
  const blocks = [];
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    for (const span of inlineCodeSpans(line[0], literalRanges, line.index)) {
      if (codeSpanInLiteral(span, literalRanges, line.index)) continue;
      const raw = span.value.trim();
      const start = /^chart(?:(?:\\r)?\\n|\\?<br\s*\/?>)/i.exec(raw);
      if (!start) continue;
      // 양끝 |는 GFM에서 선택이다. 문자 유무로 판정하면 가장자리 셀을 놓치고,
      // 반대로 표가 아닌 산문의 | 사이에 있는 코드 예시를 조회로 바꾼다.
      const contains = ([start, end]) => start <= line.index + span.start && end >= line.index + span.end;
      const inCell = syntax.tableRows.some(contains);
      if (!inCell && !syntax.standalone.some(range => contains(range) &&
        !text.slice(range[0], line.index + span.start).trim() &&
        !text.slice(line.index + span.end, range[1]).trim())) continue;
      let body = /<br/i.test(start[0]) ? decodeVisualizationBreaks(raw.slice(start[0].length))
        : decodeSerializedLines(raw.slice(start[0].length));
      if (inCell) body = body.replace(/(\\+)\|/g, (_whole, slashes) => '\\'.repeat(Math.floor(slashes.length / 2)) + '|');
      const block = [line[0].slice(span.start, span.end), '', '```', '`', body];
      block.index = line.index + span.start;
      block.serialized = { inCell };
      blocks.push(block);
    }
  }
  return blocks;
}

function serializeChartReplacement(replaced, { inCell }) {
  const match = /^```chart\n([\s\S]*?)\n```(?:\n([\s\S]*))?$/.exec(replaced);
  const escapePipes = value => inCell ? value.replace(/(\\*)\|/g,
    (_whole, slashes) => '\\'.repeat(slashes.length * 2 + 1) + '|') : value;
  if (!match) return escapePipes(replaced);
  const body = escapePipes(match[1]).replaceAll('\n', '\\n');
  const fence = '`'.repeat(Math.max(1, ...[...body.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return fence + 'chart\\n' + body + fence + (match[2] ? (inCell ? '<br>' : '\n\n') + escapePipes(match[2]) : '');
}

// 펜스는 닫는 줄이 곧 경계지만, 그 자리에 넣는 표·안내 문장은 스스로 끝나지 않는다 — GFM 표는 빈 줄이나
// 다른 블록이 와야 끝나고, 그 전까지 오는 줄을 자기 행으로 삼킨다. 그래서 바꿔 넣은 자리의 앞뒤에 빈 줄이
// 없으면 넣어 준다. 없으면 세 가지가 조용히 무너진다(실측 — remark-gfm 실물 파싱):
//   ① 표 블록 둘이 빈 줄 없이 이어지면 뒤 표의 머리글과 구분 줄('---')이 앞 표의 데이터 행이 된다.
//   ② 모델이 손으로 쓴 표 바로 뒤에 오면 열 수가 적은 앞 표에 흡수되어 뒤 표의 열이 통째로 사라진다
//      (실측: 1열 표 뒤에 붙은 2열 결과에서 STATUS 값이 화면에서 사라졌다).
//   ③ 표 바로 뒤의 설명 문장이 표의 마지막 행이 된다 — 문장이 답변에서 사라진다.
// 셋 다 채우기 '전'에는 멀쩡했다: 펜스는 스스로 닫히기 때문이다. 즉 이 치환이 스스로 만드는 실패다.
// 바꾸지 않은 블록(참조 없는 그대로 두는 블록)에는 손대지 않는다 — 원문을 건드릴 이유가 없다.
// 판정은 자리에서 한다 — 남은 글을 slice로 떼거나 지금까지 만든 글에 `$` 정규식을 걸면 블록마다 글 전체를
// 다시 훑어 '블록 수 × 답변 길이'가 된다(답변 상한 안에 빈 표 블록 수천 개가 들어간다).
// 앞쪽: 넣을 자리 바로 앞 줄이 비어 있는가. 펜스는 줄 머리에서 시작하므로 여기 오는 글은 줄 끝으로 끝난다.
const blankLineBefore = s => {
  let i = s.length;
  if (i === 0) return true;                                       // 글의 처음 — 앞 블록이 없다
  if (s[i - 1] === '\n') { i--; if (i > 0 && s[i - 1] === '\r') i--; }
  else if (s[i - 1] === '\r') i--;
  else return false;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i === 0 || s[i - 1] === '\n' || s[i - 1] === '\r';
};
// 뒤쪽: 블록 다음 자리가 빈 줄로 시작하는가(또는 거기서 글이 끝나는가). sticky라 그 자리만 본다.
const BLANK_AFTER = /\r?\n[ \t]*(?:\r?\n|$)/y;

// 앞쪽 판정에 넘기는 것은 '지금까지 만든 글' 전체가 아니라 그 꼬리다 — 이어 붙인 문자열을 인덱스로
// 읽으면 V8이 그때마다 평탄화해 블록 수 × 답변 길이가 된다(실측: 블록 4,000개에서 75ms → 6ms).
// 판정이 보는 것은 마지막 줄 끝과 그 앞 줄의 공백뿐이라 이만큼이면 넉넉하다.
const TAIL_LEN = 4096;

function replaceBlocks(text, blocks, replace) {
  let out = '';
  let tail = '';
  let at = 0;
  const push = piece => {
    if (!piece) return;
    out += piece;
    tail = piece.length >= TAIL_LEN ? piece.slice(-TAIL_LEN) : (tail + piece).slice(-TAIL_LEN);
  };
  for (const block of blocks) {
    let replaced = replace(...block, block);
    push(text.slice(at, block.index));
    at = block.index + block[0].length;
    if (replaced === block[0]) { push(replaced); continue; }
    if (block.serialized) { push(serializeChartReplacement(replaced, block.serialized)); continue; }
    if (block.container) replaced = replaced.split('\n').map((line, i) =>
      (i ? block.container.rest : block.container.first) + line).join('\n');
    if (!blankLineBefore(tail)) push('\n');
    push(replaced);
    BLANK_AFTER.lastIndex = at;
    if (at < text.length && !BLANK_AFTER.test(text)) push('\n');
  }
  return out + text.slice(at);
}
const CONFIG_RE = /^\s*(type|title|x|y|y2|xtype|data)\s*:\s*(.*?)\s*$/i;

// 셀 값을 표의 칸으로. 숫자는 천 단위 구분 없이 그대로(프런트가 숫자로 읽는다), 파이프와 줄바꿈은
// 표를 깨뜨리므로 바꾼다. null은 빈칸이다 — 'null'이라는 글자는 값으로 읽힌다.
// 홀로 선 CR도 줄바꿈이다 — markdown은 \r 하나도 줄 끝으로 읽으므로 남겨 두면 그 행이 둘로 갈라진다.
// 역슬래시도 GFM의 이스케이프 글자라 함께 두 개로 만든다 — 값 `a\|b`를 파이프만 바꿔 `a\\|b`로 적으면
// GFM은 `\\`를 역슬래시 하나로 읽고 남은 `|`에서 칸을 갈라 '표로 보기'의 열이 밀린다. 그래서 escapeCell은
// 한 번의 훑기로 글자마다 판정한다 — 치환을 겹쳐 돌리면 앞 회차가 넣은 백슬래시를 뒤 회차가 다시 센다
// (프런트 splitRow는 이 이스케이프들을 GFM과 같은 규칙으로 되돌린다).
//
// 자른 셀에는 TRUNC_MARK를 붙인다 — 이 저장소의 다른 절단(oracle.js normalizeValue, llm-openai.js clip)과 같은
// 규칙이다. 표시 없이 자르던 동안 두 가지가 조용히 어긋났다(실측). ① 사용자는 표의 값을 온전한 값으로 읽는다 —
// 드라이버 경계는 200자에서 표시를 붙이는데 그 표시까지 여기서 함께 잘려 나갔다. ② 그 답변은 다음 턴의 대화 이력으로
// 되돌아오고, 모델이 표의 값을 바인드로 옮겨 적으면 잘린 값 가드(agent.js clippedCopyDetector)는 표시를 근거로
// 앞부분을 찾으므로 표시가 없는 이 절단은 한 번도 인식하지 못했다 — 잘린 조각으로 조회가 실행돼 0건이 나오고
// 모델은 그것을 "없다"로 읽는다. 표시가 붙으면 모델은 시스템 프롬프트의 규칙(표시로 끝나는 값은 바인드로 쓰지
// 마라)을 받고, 앞부분만 옮겨 적어도 가드가 이 길이(MAX_TABLE_CELL_LEN·MAX_CHART_CELL_LEN)의 앞부분을 안다.
const marked = (v, max) => {
  const s = String(v);
  return s.length > max ? clipText(s, max) + TRUNC_MARK : s;
};
// 개행은 '문자 하나에 공백 하나'로 바꾼다 — CRLF를 공백 한 칸으로 접으면 안 된다.
// 잘린 값 가드(agent.js clippedCopyDetector)는 칸에 보인 앞부분을 '우리가 자른 길이'(MAX_TABLE_CELL_LEN·
// MAX_CHART_CELL_LEN·MAX_CELL_LEN, 각각의 서로게이트 한 칸 짧은 길이)와 대조해 알아본다. 이스케이프는
// unescapeCell이 정확히 되돌리지만 개행 접기는 되돌릴 수 없으므로, 두 글자를 한 글자로 접는 순간 그 길이가
// 어긋나 가드가 자기가 보여준 앞부분을 못 알아본다 — CRLF가 둘만 들어 있어도 그렇다(실측: 120자 칸이 117자로
// 보여 대조를 비켜 갔다). 그러면 모델이 그 조각으로 조회해 0건을 받고 "없다"로 단정하는, 이 가드가 막기로 한
// 실패가 그대로 난다. 공백 두 칸은 markdown이 한 칸으로 렌더하므로 화면은 달라지지 않는다.
// 파이프·역슬래시 말고도 막아야 하는 것이 있다. 채운 칸은 **markdown 표의 인라인 문맥**이라, 값에 든
// 강조·코드·링크·취소선·HTML·엔터티 표기가 그대로 해석된다 — 파이프처럼 열을 밀지는 않지만 값을 조용히
// 바꾼다(실측: 치수 '10*20*30'이 화면에 '102030'으로, '~미사용~'이 '미사용'으로, '__init__'이 'init'으로,
// '&amp;'가 '&'로, '노트: `code`'가 '노트: code'로 나갔다 — remark-gfm 실물 파싱). 사용자는 조회 결과를
// 원문으로 읽고 그 값을 다음 질문에 옮겨 적으므로, 이 코드베이스가 가장 나쁘게 보는 '조용한 오답'이다.
// 자른 값에 표시를 붙이기로 한 것(marked)과 같은 이유다: 화면의 값은 DB의 값과 같아야 한다.
//
// 다만 '위험한 글자를 늘 막는' 방식은 쓰지 않는다. 이 글자는 이력으로 되돌아가 모델이 다시 읽는 자리이고
// (chartBlocksToTables), 이 시스템의 값에는 밑줄이 흔하다 — BATCH_JOB_STATUS·order_id를 늘 막으면 모델이
// 보는 값이 항상 어긋난다. 그래서 **그 칸에서 실제로 구성요소가 될 수 있을 때만** 막는다. 구성요소는 전부
// 짝이 있어야 성립하므로 판정이 정확하다(CommonMark: 강조는 여는·닫는 구분자 한 쌍, 코드는 백틱 한 쌍,
// 링크는 '['보다 뒤의 ']', 원시 HTML·자동링크는 '<'보다 뒤의 '>', 엔터티는 '&이름;'). 밑줄만 규칙이 하나 더
// 붙는다: 낱말 가운데의 '_'는 강조를 열지도 닫지도 못하므로(CommonMark의 intraword 예외) 그런 것은 세지
// 않는다 — 그래서 식별자꼴 값은 지금까지와 글자 하나 다르지 않다.
// 되돌리는 쪽(agent.js unescapeCell, frontend/src/chart.js splitRow)이 같은 목록을 본다 — 한쪽만 늘리면
// 화면에 백슬래시가 남거나 잘린 값 가드가 길이를 못 맞춘다.
//
// '$'도 같은 목록에 든다. markdown 자체의 구성요소는 아니지만 이 칸을 실제로 그리는 파이프라인이
// 수식을 함께 읽기 때문이다(frontend/src/math.js REMARK_PLUGINS = remark-gfm + remark-math + remarkLooseMath).
// 그래서 셀에 든 '$…$'·'$$…$$'가 조판으로 바뀌어 달러 기호가 사라진다(실측 — 프런트 실물 파이프라인:
// '$x$' → 'x', '수식 $a+b$ 참고' → '수식 a+b 참고', '$$100$$' → '100'). 이 함수가 보는 문법은
// CommonMark가 아니라 '이 글자를 읽는 쪽'이어야 한다 — 22회차에 remark-gfm으로 목록을 맞춘 것과 같은 이유다.
// 짝 규칙은 그대로라 홑 '$'는 손대지 않는다: $HOME·V$SESSION·'$100 ~ $200'은 글자 하나 달라지지 않는다.
const isAlnum = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
// 자리에서 바로 본다(sticky) — 남은 문자열을 slice로 떼면 '& 수 × 셀 길이'라 이차가 된다
// (llm-openai.js keepsControlMeaning에 같은 이유를 적어 두었다).
const ENTITY_AT = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/y;

// ===== GFM 자동 링크(literal) 구간 =====
// 값에 든 주소는 GFM이 통째로 링크로 만들고 그 안에서는 아무 구성요소도 읽지 않는다
// (실측 — remark-gfm: 'http://a.com/x*b*c'의 '*'도, '~'·'`'·'_'·'['·'&amp;'도 전부 원문 그대로 남는다).
// 즉 여기서는 막을 것이 없는데, 막으면 두 가지를 함께 잃는다: 백슬래시가 화면 글자로 그대로 보이고
// (값이 달라진다) 링크의 '주소'에도 들어가 클릭이 엉뚱한 곳으로 간다
// (실측: 'http://intra/a*b*c' → 화면·href 모두 'http://intra/a\*b\*c'). 뒤쪽이 특히 나쁘다 —
// 조회 결과에 실린 주소는 눌러 보라고 있는 것이고, 그 실패는 404 한 번으로만 보여 원인이 보이지 않는다.
//
// 판정은 '반드시 링크가 된다'는 모양으로만 좁힌다. 넓게 잡아 링크가 아닌 자리를 놓치면 그 글자가
// 구성요소가 되어 값이 바뀌는데, 그것이 이 함수가 막기로 한 실패다. 좁게 잡아 놓치는 쪽은 지금과 같다.
//   ① 글의 처음이거나 앞이 공백 — 우리가 막는 글자가 아니라서 그 자리에 백슬래시가 끼어들지 않는다.
//   ② www. | http:// | https:// 로 시작하고, 다음 공백 앞까지가 한 구간이다.
//   ③ 도메인이 아래 LINK_DOMAIN 모양 — 이 칸을 실제로 그리는 파서(remark-gfm/micromark)가 링크로 받는
//      모양의 부분집합이다. 경계는 실측으로 잡았다: '_'가 든 도메인은 링크가 아니고
//      (http://a_b.com/x·http://a.b_c.com/x는 그냥 글자다), 점 없는 사내 호스트(http://intra/…)는 링크다.
//   ④ 링크가 낱말의 '끝까지' 간다 — 그래야 보호 구간과 링크 구간이 정확히 같아져, 링크 안에
//      백슬래시가 들어가는 일도, 링크 밖에 막지 않은 글자가 남는 일도 없다 (아래 full의 ③~⑤).
// 구간 안에서도 '\'와 '|'는 그대로 막는다: 파이프는 칸을 갈라 행을 무너뜨리고, 역슬래시를 그냥 두면
// 구간 끝의 '\'가 바로 뒤 이스케이프의 백슬래시와 붙어 다른 뜻이 된다.
//
// 이 판정이 파서의 실제 동작에 기대고 있다는 것을 잊지 말 것 — 넓어지면(링크가 아닌 자리를 보호하면)
// 그 글자가 구성요소가 되어 값이 조용히 바뀐다. 그래서 실물 렌더러로 원문을 대조하는 회귀 테스트를
// 프런트에 둔다(frontend/test/chart.test.js) — 파서를 갈아 끼우면 그 테스트가 먼저 깨진다.
//
// 낱말은 앞 글자를 가리지 않고 잡는다(실측: '5http://intra$'의 주소도 링크다). 앞 조건은 아래 full에만 건다.
const URLISH_TOKEN = /(?:https?:\/\/|www\.)[^ \t]*/gi;
const LINK_SCHEME = /^https?:\/\//i;
// 파서가 '도메인'으로 읽는 글자 — 영숫자·'_'·'-'·'.'과 비ASCII. 그 뒤는 경로라 무엇이 와도 된다.
const LINK_DOMAIN = /^[A-Za-z0-9_.\-¡-￿]*/;
// 낱말 끝의 이 글자들은 링크에서 떨어져 나온다(micromark tokenizeTrail) — 그러면 보호 구간이 링크보다
// 길어지므로 아예 보호하지 않는다.
const LINK_TRAIL_END = /[!"'),.:;?_~*]$|&[a-zA-Z]+;$/;

// 구간마다 두 가지를 돌려준다.
//   full=true  — 낱말 전체가 그대로 링크가 된다. 이 구간에서는 아무것도 막지 않는다.
//   full=false — 링크인지, 어디까지가 링크인지 확실하지 않다. 종전대로 막되 '$'만은 막지 않는다:
//                '$'는 이번에 새로 막기 시작한 글자라, 여기서 막으면 '실제로는 링크였던' 구간에
//                없던 백슬래시를 새로 집어넣게 된다(그 자리는 지금까지 아무 문제가 없던 곳이다).
//                막지 않아서 손해 보는 것은 '링크가 아닌 주소꼴 낱말 안의 $…$'뿐이고, 그것은 지금과 같다.
function autolinkRanges(s) {
  // 주소가 없는 값(대부분)은 정규식 한 번으로 끝난다.
  if (!/https?:\/\/|www\./i.test(s)) return null;
  let ranges = null;
  for (const m of s.matchAll(URLISH_TOKEN)) {
    const run = m[0];
    const domain = LINK_DOMAIN.exec(run.replace(LINK_SCHEME, ''))[0];
    const full =
      // ① 글의 처음이거나 앞이 공백 — 그 자리는 우리가 막는 글자가 아니라 백슬래시가 끼어들지 않는다.
      (m.index === 0 || s[m.index - 1] === ' ' || s[m.index - 1] === '\t')
      // ② 도메인에 '_'가 하나라도 있으면 확신하지 않는다. 파서는 '마지막 두 조각'만 보지만(micromark
      //    tokenizeDomain), 그 셈은 끝의 '.'이 링크에서 떨어져 나가는지까지 함께 봐야 해서 이쪽에서
      //    정확히 흉내 낼 값이 아니다 — 좁은 쪽(막는 쪽)으로 둔다.
      && domain.length >= 2 && !domain.includes('_') && !/^[.-]/.test(domain)
      // ③ 앞에 짝 없는 '['·'<'가 있으면 그 뒤의 자동 링크는 아예 만들어지지 않는다 — 링크 라벨·원시 HTML의
      //    시작으로 읽혀 뒤가 통째로 그 안에 들어간다(실측: '[ https://localhost/x'는 링크가 아니다).
      //    우리는 ']'만 막으므로 값에 든 '['는 언제나 짝을 잃은 채 남는다 — 그 앞자락을 함께 봐야 한다.
      && !/[[<]/.test(s.slice(0, m.index))
      // ④ 낱말 안의 '<'·']'는 링크를 거기서 끝낸다 (micromark tokenizePath/tokenizeTrail).
      && !run.includes('<') && !run.includes(']')
      // ⑤ 낱말 끝의 문장부호·엔터티는 링크 밖으로 떨어진다.
      && !LINK_TRAIL_END.test(run);
    (ranges ??= []).push([m.index, m.index + run.length, full]);
  }
  return ranges;
}

export function escapeCell(value) {
  const s = String(value ?? '').replace(/[\r\n]/g, ' ');
  // 세는 단위는 글자가 아니라 '구분자 런'이다 — CommonMark는 이어진 같은 글자를 구분자 하나로 본다.
  // 글자로 세면 `METRIC__FIRST`(런 하나)나 `**`가 짝이 있는 것으로 잘못 잡혀, 막을 이유가 없는 값까지
  // 이력에서 백슬래시가 붙은 채 모델에게 되돌아간다(실측: 등록 컬럼명에서 그렇게 걸렸다).
  const runs = ch => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === ch && s[i - 1] !== ch) n++;
    return n;
  };
  const paired = new Set();
  for (const ch of ['*', '`', '~', '$']) if (runs(ch) >= 2) paired.add(ch);
  // 링크·이미지·각주는 닫는 ']'만 막아도 전부 성립하지 못한다 — 여는 '['는 짝을 잃으면 그냥 글자다
  // (실측: '[x\](y)'·'![a\](b.png)'·'[a\][b\]'·'[^1\]'이 모두 원문 그대로 남는다).
  // '['를 함께 막으면 안 된다. 그러면 우리가 쓴 '\[…\]'가 **수식 표시**가 되어, 이 칸을 그리는
  // 파이프라인(frontend/src/math.js remarkLooseMath)이 그것을 원문에서 알아보고 조판해 버린다 —
  // markdown이 백슬래시를 떼어 '[ ]'만 남기는 표기를 되살리는 것이 그 플러그인의 존재 이유라,
  // 우리의 이스케이프가 곧 그 표기가 된다. 실측: '[ERROR]'가 화면에서 대괄호를 잃고 수식 'ERROR'로,
  // '상태[1]'이 '상태' + 수식 '1'로, 'JSON: {"a":[1,2]}'가 '{"a":' + 수식 '1,2' + '}'로 나갔다.
  // 대괄호는 조회 결과에 흔하다([ERROR]·[BATCH001]·배열 첨자) — 가장 조용하고 가장 자주 나는 오답이다.
  if (s.indexOf('[') >= 0 && s.indexOf('[') < s.lastIndexOf(']')) paired.add(']');
  if (s.indexOf('<') >= 0 && s.indexOf('<') < s.lastIndexOf('>')) paired.add('<');
  // '_'만 규칙이 하나 더 붙는다: 런의 양옆이 모두 글자·숫자면 강조를 열지도 닫지도 못한다(intraword 예외).
  // 그런 런은 짝으로 세지 않고 막지도 않는다 — BATCH_JOB_STATUS·order_id가 지금까지와 같은 글자로 남는 이유다.
  const looseAt = i => {
    if (s[i] !== '_' || s[i - 1] === '_') return -1;      // 런의 첫 글자에서만 잰다
    let end = i;
    while (s[end + 1] === '_') end++;
    return isAlnum(s[i - 1]) && isAlnum(s[end + 1]) ? -1 : end;
  };
  const looseUnderscore = new Set();
  let looseRuns = 0;
  for (let i = 0; i < s.length; i++) {
    const end = looseAt(i);
    if (end < 0) continue;
    looseRuns++;
    for (let j = i; j <= end; j++) looseUnderscore.add(j);
  }
  // 자동 링크 구간은 커서 하나로 따라간다 — 구간마다 배열을 다시 훑으면 '글자 수 × 구간 수'가 된다.
  // 구간은 겹치지 않고 앞에서부터 나온다(matchAll).
  const links = autolinkRanges(s);
  let at = 0;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // 파이프·역슬래시는 자동 링크 안에서도 막는다 (위 자동 링크 머리말).
    if (c === '\\' || c === '|') { out += `\\${c}`; continue; }
    while (links && at < links.length && links[at][1] <= i) at++;
    const inLink = links && at < links.length && i >= links[at][0];
    if (inLink && (links[at][2] || c === '$')) { out += c; continue; }
    if (paired.has(c)) { out += `\\${c}`; continue; }
    if (c === '_' && looseRuns >= 2 && looseUnderscore.has(i)) { out += '\\_'; continue; }
    if (c === '&' && ((ENTITY_AT.lastIndex = i), ENTITY_AT.test(s))) { out += '\\&'; continue; }
    out += c;
  }
  return out;
}
const cell = v => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : marked(v, MAX_CHART_CELL_LEN);
  return escapeCell(s);
};

const splitNames = v => String(v ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

// Oracle의 따옴표 컬럼명은 대소문자가 다르면 별개의 열이다. 정확한 이름부터 찾는다.
const findColumn = (keys, name) => keys.find(k => k === name)
  ?? keys.find(k => nameKey(k) === nameKey(name));

// 표에 실을 열. 프런트(chart.js parseChartBlock)가 표를 읽는 규칙에 맞춘다: x는 `x:`로 적은 열이고 적지
// 않았거나 없는 이름이면 첫 열, 값은 `y:`·`y2:`로 적은 열들이다. 그래서 x는 언제나 싣고 맨 앞에 둔다 —
// `x:` 없이 `y: a, b`만 적은 블록에 a·b만 실으면 프런트는 a를 x로 삼아 b 하나를 그린다(조용한 오답).
// 값 열의 이름이 하나도 맞지 않으면(적지 않았거나 전부 오타) 결과의 앞 열들로 MAX_CHART_COLS까지 채운다 —
// 이름 하나가 틀렸다고 차트를 잃는 것보다, 프런트가 숫자 열을 스스로 고르게 두는 편이 낫다. 이때도 x는
// 반드시 넣고 열 순서는 결과의 순서를 지킨다(프런트는 이름으로 찾으므로 x의 자리는 상관없다).
// oracle.js normalizeCells가 붙인 생략 안내 열은 keys에서 이미 뺐다.
function pickColumns(config, keys) {
  const find = names => names.map(w => findColumn(keys, w)).filter(k => k !== undefined);
  const x = find(splitNames(config.x))[0] ?? keys[0];
  const ys = [...new Set(find([...splitNames(config.y), ...splitNames(config.y2)]))].filter(k => k !== x);
  if (ys.length) return [x, ...ys];
  const filler = keys.filter(k => k !== x).slice(0, MAX_CHART_COLS - 1);
  return keys.filter(k => k === x || filler.includes(k));
}

// 블록 본문을 설정·표·나머지 줄로 가른다 (frontend splitBlock과 같은 판정, 다만 줄을 버리지 않고 돌려준다).
// '표가 있다'는 파이프 줄이 둘 이상일 때다 — 머리글 한 줄뿐인 표는 프런트도 그리지 못하고('행 없음'),
// 파이프 하나 든 설명 줄("1월 | 2월 비교")을 표로 치면 data 참조를 버리고 그 줄을 표라며 프런트에 넘기게 된다.
function splitBlock(body) {
  const config = {};
  const lines = [];
  let inTable = false;
  for (const raw of body.split(/\r\n?|\n/)) {
    const m = !inTable && CONFIG_RE.exec(raw);
    if (m) { config[m[1].toLowerCase()] = m[2]; lines.push({ raw, key: m[1].toLowerCase() }); continue; }
    if (raw.includes('|')) inTable = true;
    lines.push({ raw, table: raw.includes('|') });
  }
  return { config, lines, hasTable: lines.filter(l => l.table).length >= 2 };
}

// `data:` 값에서 스텝 번호를. 'step 2' · '2' · '실행 2' · '#2' 를 모두 받는다 — 모델이 프롬프트의
// '실행 N' 표기를 그대로 옮기는 일이 있다. 숫자가 없으면 null.
const stepOf = value => {
  const match = /^(?:(?:step|실행)\s*|#\s*)?(\d+)$/i.exec(String(value ?? '').trim());
  const step = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(step) ? step : null;
};

// 안내 문장은 펜스가 있던 자리(목록 안이면 그 들여쓰기)에 놓는다.
const note = (config, why, indent = '') => {
  const title = String(config.title ?? '').trim();
  return `${indent}_${title ? `'${title}' ` : ''}차트를 그리지 못했습니다: ${why}_`;
};

// answer 안의 차트 블록을 채운다. steps[i]는 history[i]의 전체 행(성공한 조회) 또는 null(오류·메모).
// 차트 블록이 없으면 원문 그대로 돌려준다 — 대부분의 답변이 그렇고, 그 경로는 정규식 한 번이다.
// 글자 예산은 채울 블록들에 고르게 나눈다: 블록의 몫 = 남은 예산 ÷ 남은 블록 수. 덜 쓴 몫은 뒤로 넘어간다
// (llm-openai.js renderSections가 섹션에 예산을 나누는 것과 같은 생각 — 앞이 뒤를 굶기지 못하게).
// 넓은 표가 앞에 오면 그 표는 몫만큼만 싣고 뒤의 좁은 표가 남긴 몫은 돌려받지 못한다 — 그 대신 어느 블록도
// 표를 통째로 잃지는 않는다.
export function resolveChartData(answer, steps) {
  const original = String(answer ?? '');
  if (!/(?:`|~~~)[ \t]*chart/i.test(original)) return original;
  const needsFill = body => { const b = splitBlock(body); return b.config.data !== undefined && !b.hasTable; };
  const syntax = answerSyntax(original, { serialized: /`[ \t]*chart(?=(?:\\r)?\\n|\\?<br\s*\/?>)/i.test(original) });
  const text = syntax.source;
  const blocks = [...fencedBlocks(text, 'chart', syntax), ...serializedChartBlocks(text, syntax)].sort((a, b) => a.index - b.index);
  let blocksLeft = blocks.filter(m => needsFill(m[4] ?? '')).length;
  let budget = MAX_CHART_INJECT_LEN;
  const resolved = replaceBlocks(text, blocks, (whole, indent, fence, _ch, body = '', sourceBlock) => {
    const { config, lines, hasTable } = splitBlock(body);
    if (config.data === undefined) return whole;
    // 표가 함께 있으면 표가 우선이다 — data 줄만 지운다 (프런트는 어차피 무시하지만, 이력으로
    // 되돌아갈 때 남을 이유가 없다).
    if (hasTable) return `${indent}${fence}chart\n${lines.filter(l => l.key !== 'data').map(l => l.raw).join('\n')}\n${indent}${fence}`;
    // 채울 때는 설정 줄만 남긴다 — 그 밖의 줄(설명 문장, 파이프 하나 든 줄)은 프런트가 표로 오인하거나 버린다.
    const kept = lines.filter(l => l.key && l.key !== 'data').map(l => l.raw);
    // 직렬화 개행·바깥 셀 이스케이프가 늘리는 크기도 같은 답변 예산에 포함한다.
    const expansion = sourceBlock.serialized ? 3 : 1;
    const allow = Math.floor(budget / Math.max(1, blocksLeft--) / expansion);

    const n = stepOf(config.data);
    const rows = n !== null && n >= 1 ? steps?.[n - 1] : undefined;
    if (n === null) return note(config, 'data 참조에 실행 번호가 없습니다', indent);
    if (!Array.isArray(rows)) return note(config, `실행 ${n}의 결과가 없습니다`, indent);
    if (!rows.length) return note(config, `실행 ${n}의 조회 결과가 0건입니다`, indent);
    const keys = dataKeys(rows[0]);
    if (keys.length < 2) return note(config, `실행 ${n}의 결과에 그릴 열이 부족합니다`, indent);
    if (allow <= 0) return note(config, '답변에 실을 수 있는 표의 양을 넘었습니다', indent);

    const cols = pickColumns(config, keys);
    const table = [`${indent}| ${cols.map(escapeCell).join(' | ')} |`, `${indent}|${' --- |'.repeat(cols.length)}`];
    let used = table[0].length + table[1].length + 2;
    let taken = 0;
    for (const r of rows) {
      if (taken >= MAX_CHART_BLOCK_ROWS) break;
      const line = `${indent}| ${cols.map(c => cell(dataValue(r, c))).join(' | ')} |`;
      if (used + line.length + 1 > allow) break;
      table.push(line);
      used += line.length + 1;
      taken++;
    }
    budget -= used * expansion;
    if (!taken) return note(config, '답변에 실을 수 있는 표의 양을 넘었습니다', indent);
    const block = `${indent}${fence}chart\n${[...kept, ...table].join('\n')}\n${indent}${fence}`;
    // 행 상한이나 예산에 걸려 다 싣지 못한 표는 그 사실을 차트 아래 밝힌다 — 그래프만 보면 그것이 전부로 읽힌다.
    return taken < rows.length ? `${block}\n${indent}_(표는 ${rows.length}행 중 처음 ${taken}행까지만 실었습니다)_` : block;
  });
  return resolved === text ? original : resolved;
}

// ===== 조회 결과 표 (```table 블록) =====
// 답변의 ```table 블록에서 `step: N` 참조를 실제 조회 결과의 markdown 표로 채운다. 차트와 같은 이유·같은 규칙이다
// (파일 머리말). 게다가 표는 모델이 답변마다 가장 많이 옮겨 적는 것이다 — 20행 × 6열이면 수백에서 천 토큰을
// 모델이 한 글자씩 생성하고, 출력 토큰은 prefill보다 수십 배 느리다. 그 출력이 답변 지연의 큰 몫이었다.
// 참조 한 줄이면 서버가 채우고, 옮겨 적다 틀리는 값(반올림·자릿수 누락)도 없다.
// 블록 문법: step: N (필수), cols: 열이름들 (선택 — 결과의 일부 열만), limit: 행 수 (선택, MAX_TABLE_BLOCK_ROWS까지).
// 차트 습관대로 data: step N 으로 적은 것도 받는다. 채운 결과는 펜스 없는 GFM 표다 — 프런트는 평범한 표로 그린다.
export const MAX_TABLE_BLOCK_ROWS = 100;     // limit의 상한 (차트와 같다) — 전부는 trace 패널의 몫이다
export const DEFAULT_TABLE_ROWS = 30;        // limit을 적지 않았을 때. 모델이 보던 20행보다 조금 넉넉하되 말풍선을 가득 채우지 않는다
export const MAX_TABLE_COLS = 10;            // cols를 적지 않았을 때 싣는 열 수 — SELECT * 30열은 markdown 표로는 읽을 수 없다
export const MAX_TABLE_CELL_LEN = 120;       // 표의 칸. 프롬프트 셀 상한(200)보다 짧고 차트(60)보다 길다
export const MAX_TABLE_INJECT_LEN = 30_000;  // 답변 하나에 채워 넣는 표의 총 글자 수 (차트 예산과 별도 — 둘 다 MAX_ANSWER_LEN 위에 얹힌다)

// DB 값의 <br>는 셀 줄바꿈 문법이 아니다. 해당 토큰만 인라인 코드로 보호해
// 일반 문자의 내용·주변 공백·나머지 Markdown 이스케이프를 그대로 유지한다.
export const escapeTableCell = value => escapeCell(value).replace(/\\(<br\s*\/?>)/gi, '`$1`');

// chart와 같은 fencedBlocks 경계 판정을 사용한다.
const TABLE_CONFIG_RE = /^\s*(step|data|cols|limit)\s*:\s*(.*?)\s*$/i;

// 표의 칸 — 차트의 cell과 같은 이스케이프·같은 절단 표시, 상한만 다르다 (cell 주석 참고).
const tableCell = v => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : marked(v, MAX_TABLE_CELL_LEN);
  return escapeTableCell(s);
};

const tableNote = (why, indent = '') => `${indent}_표를 채우지 못했습니다: ${why}_`;

// answer 안의 표 블록을 채운다. steps는 resolveChartData와 같은 배열이다.
// 표 블록이 없으면 원문 그대로 돌려준다 — 그 경로는 정규식 한 번이다.
// 글자 예산은 채울 블록들에 고르게 나눈다 (resolveChartData와 같은 생각).
export function resolveTableData(answer, steps) {
  const text = String(answer ?? '');
  if (!/(?:```|~~~)[ \t]*table/i.test(text)) return text;
  const refOf = body => {
    const config = {};
    for (const raw of body.split(/\r\n?|\n/)) {
      const m = TABLE_CONFIG_RE.exec(raw);
      if (m) config[m[1].toLowerCase()] = m[2];
    }
    return { config, ref: config.step ?? config.data };
  };
  // 예산은 '채울 블록'에만 나눈다 — 참조 없는 블록까지 세면 아무것도 쓰지 않는 블록이 몫을 가져가
  // 정작 채우는 표가 잘린다 (실측: 참조 없는 블록 넷이 섞이자 87행이 17행이 됐다).
  // 차트 쪽(resolveChartData)이 needsFill로 미리 거르는 것과 같은 이유·같은 방식이다.
  const blocks = fencedBlocks(text, 'table', answerSyntax(text));
  let blocksLeft = blocks.filter(m => refOf(m[4] ?? '').ref !== undefined).length;
  let budget = MAX_TABLE_INJECT_LEN;
  return replaceBlocks(text, blocks, (whole, indent, _fence, _ch, body = '') => {
    const { config, ref } = refOf(body);
    // 참조가 없을 때 할 일이 세 경우에 다르다.
    //   cols·limit 같은 이 블록의 설정 줄이 있다 — 모델이 이 블록을 쓰려다 step만 빠뜨린 것이다. 본문을
    //     그대로 내보내면 'cols: A' 'limit: 5'라는 설정 줄이 답변 글자로 사용자에게 보인다. 안내로 바꾼다.
    //   본문에 보이는 글자가 있다 — 모델이 펜스를 다른 용도로 쓴 것이다. 펜스만 벗겨 본문이 렌더되게 한다
    //     (표를 손수 적었으면 표로, 다른 글이면 글로). 그대로 두면 화면이 코드블록으로 보여 무엇인지 알 수
    //     없다 — 프런트는 chart·mermaid 펜스만 따로 알아보기 때문이다(차트 블록을 손대지 않는 것과 다른 이유다).
    //   본문이 비었다 — '다른 용도'가 아니다. 벗길 본문이 없으므로 벗기면 그 블록 자리에 아무것도 남지
    //     않는데, 그 블록이 답변의 전부이면 답변 자체가 빈 문자열이 된다 (실측: 여는 펜스와 닫는 펜스
    //     사이가 비었거나 공백뿐인 table 블록 하나만 든 답변).
    //     빈 답변은 이 저장소가 두 곳에서 막기로 한 것이다 — llm-openai.js toDecision이 결정으로 받지 않고
    //     agent.js answerOf가 폴백으로 넘기는데, 후처리는 그 둘보다 '뒤'라 두 가드를 모두 지난 답변을
    //     비워 버린다. 화면에는 빈 말풍선이 뜨고 chat_log에는 답한 것으로 기록된다. 설정 줄만 있는 블록과
    //     같은 실패(쓰려다 만 표)이므로 같은 안내로 바꾼다.
    if (ref === undefined) return Object.keys(config).length || !body.trim() ? tableNote('step 참조가 없습니다', indent) : body;
    const allow = Math.floor(budget / Math.max(1, blocksLeft--));

    const n = stepOf(ref);
    const rows = n !== null && n >= 1 ? steps?.[n - 1] : undefined;
    if (n === null) return tableNote('step 참조에 실행 번호가 없습니다', indent);
    if (!Array.isArray(rows)) return tableNote(`실행 ${n}의 결과가 없습니다`, indent);
    if (!rows.length) return `${indent}_실행 ${n}의 조회 결과가 0건입니다_`;
    // 열은 모든 행의 합집합이다 (llm.js rowsToMarkdownTable과 같은 이유 — 뒤 행에만 있는 열이 사라지지 않게)
    const keys = [...new Set(rows.flatMap(dataKeys))];
    if (!keys.length) return tableNote(`실행 ${n}의 결과에 열이 없습니다`, indent);
    if (allow <= 0) return tableNote('답변에 실을 수 있는 표의 양을 넘었습니다', indent);

    // 열: cols로 고른 것(대소문자 무시, 없는 이름은 버린다). 없거나 전부 틀리면 앞 열들 — 이름 하나가 틀렸다고
    // 표를 잃는 것보다 낫다 (차트 pickColumns와 같은 판단).
    const picked = [...new Set(splitNames(config.cols).map(w => findColumn(keys, w)).filter(k => k !== undefined))];
    const cols = picked.length ? picked : keys.slice(0, MAX_TABLE_COLS);
    const limitRaw = Number.parseInt(String(config.limit ?? ''), 10);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_TABLE_BLOCK_ROWS) : DEFAULT_TABLE_ROWS;

    const table = [`${indent}| ${cols.map(escapeTableCell).join(' | ')} |`, `${indent}|${' --- |'.repeat(cols.length)}`];
    let used = table[0].length + table[1].length + 2;
    let taken = 0;
    for (const r of rows) {
      if (taken >= limit) break;
      const line = `${indent}| ${cols.map(c => tableCell(dataValue(r, c))).join(' | ')} |`;
      if (used + line.length + 1 > allow) break;
      table.push(line);
      used += line.length + 1;
      taken++;
    }
    budget -= used;
    if (!taken) return tableNote('답변에 실을 수 있는 표의 양을 넘었습니다', indent);
    // 다 싣지 못한 것은 표 아래 밝힌다 — 표만 보면 그것이 전부로 읽힌다.
    const notes = [];
    if (taken < rows.length) notes.push(`${rows.length}행 중 처음 ${taken}행`);
    if (!picked.length && cols.length < keys.length) notes.push(`${keys.length}열 중 앞 ${cols.length}열`);
    const tail = notes.length ? `\n${indent}_(${notes.join(', ')}만 실었습니다 — 전부는 아래 ⚡ 패널에 있습니다)_` : '';
    return table.join('\n') + tail;
  });
}
