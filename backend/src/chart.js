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

import { nameKey, clipText } from './constants.js';

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

// frontend/src/chart.js CHART_FENCE_RE와 같은 모양(왜 이렇게 너그러운지도 거기 적혀 있다). 여기서 놓친 블록은
// 채워지지 않은 `data:` 참조로 화면에 간다. 들여쓰기(목록 안의 펜스)는 m[1]로 받아 채워 넣는 줄에도 붙인다.
const FENCE_RE = /^([ \t]*)```[ \t]*chart(?:[ \t]+[^\r\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]*`{3,}[ \t]*\r?$/gim;
const CONFIG_RE = /^\s*(type|title|x|y|y2|xtype|data)\s*:\s*(.*?)\s*$/i;

// 셀 값을 표의 칸으로. 숫자는 천 단위 구분 없이 그대로(프런트가 숫자로 읽는다), 파이프와 줄바꿈은
// 표를 깨뜨리므로 바꾼다. null은 빈칸이다 — 'null'이라는 글자는 값으로 읽힌다.
// 홀로 선 CR도 줄바꿈이다 — markdown은 \r 하나도 줄 끝으로 읽으므로 남겨 두면 그 행이 둘로 갈라진다.
// 역슬래시는 GFM의 이스케이프 글자라 그것부터 두 개로 만든다 — 값 `a\|b`를 파이프만 바꿔 `a\\|b`로 적으면
// GFM은 `\\`를 역슬래시 하나로 읽고 남은 `|`에서 칸을 갈라 '표로 보기'의 열이 밀린다(프런트 splitRow는
// 이 두 이스케이프를 GFM과 같은 규칙으로 되돌린다).
const cell = v => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : clipText(String(v), MAX_CHART_CELL_LEN);
  return s.replace(/\r\n?|\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
};

const splitNames = v => String(v ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

// 표에 실을 열. 프런트(chart.js parseChartBlock)가 표를 읽는 규칙에 맞춘다: x는 `x:`로 적은 열이고 적지
// 않았거나 없는 이름이면 첫 열, 값은 `y:`·`y2:`로 적은 열들이다. 그래서 x는 언제나 싣고 맨 앞에 둔다 —
// `x:` 없이 `y: a, b`만 적은 블록에 a·b만 실으면 프런트는 a를 x로 삼아 b 하나를 그린다(조용한 오답).
// 값 열의 이름이 하나도 맞지 않으면(적지 않았거나 전부 오타) 결과의 앞 열들로 MAX_CHART_COLS까지 채운다 —
// 이름 하나가 틀렸다고 차트를 잃는 것보다, 프런트가 숫자 열을 스스로 고르게 두는 편이 낫다. 이때도 x는
// 반드시 넣고 열 순서는 결과의 순서를 지킨다(프런트는 이름으로 찾으므로 x의 자리는 상관없다).
// '…'는 oracle.js normalizeCells가 잘린 컬럼 수를 적어 두는 표시 열이라 keys에서 이미 뺐다.
function pickColumns(config, keys) {
  const byKey = new Map(keys.map(k => [nameKey(k), k]));
  const find = names => names.map(w => byKey.get(nameKey(w))).filter(k => k !== undefined);
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
const stepOf = v => { const m = /(\d+)/.exec(String(v ?? '')); return m ? Number(m[1]) : null; };

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
  const text = String(answer ?? '');
  if (!/```[ \t]*chart/i.test(text)) return text;
  const needsFill = body => { const b = splitBlock(body); return b.config.data !== undefined && !b.hasTable; };
  let blocksLeft = [...text.matchAll(FENCE_RE)].filter(m => needsFill(m[2])).length;
  let budget = MAX_CHART_INJECT_LEN;
  return text.replace(FENCE_RE, (whole, indent, body) => {
    const { config, lines, hasTable } = splitBlock(body);
    if (config.data === undefined) return whole;
    // 표가 함께 있으면 표가 우선이다 — data 줄만 지운다 (프런트는 어차피 무시하지만, 이력으로
    // 되돌아갈 때 남을 이유가 없다).
    if (hasTable) return `${indent}\`\`\`chart\n${lines.filter(l => l.key !== 'data').map(l => l.raw).join('\n')}\n${indent}\`\`\``;
    // 채울 때는 설정 줄만 남긴다 — 그 밖의 줄(설명 문장, 파이프 하나 든 줄)은 프런트가 표로 오인하거나 버린다.
    const kept = lines.filter(l => l.key && l.key !== 'data').map(l => l.raw);
    const allow = Math.floor(budget / Math.max(1, blocksLeft--));

    const n = stepOf(config.data);
    const rows = n !== null && n >= 1 ? steps?.[n - 1] : undefined;
    if (n === null) return note(config, 'data 참조에 실행 번호가 없습니다', indent);
    if (!Array.isArray(rows)) return note(config, `실행 ${n}의 결과가 없습니다`, indent);
    if (!rows.length) return note(config, `실행 ${n}의 조회 결과가 0건입니다`, indent);
    const keys = Object.keys(rows[0]).filter(k => k !== '…');
    if (keys.length < 2) return note(config, `실행 ${n}의 결과에 그릴 열이 부족합니다`, indent);
    if (allow <= 0) return note(config, '답변에 실을 수 있는 표의 양을 넘었습니다', indent);

    const cols = pickColumns(config, keys);
    const table = [`${indent}| ${cols.map(cell).join(' | ')} |`, `${indent}|${' --- |'.repeat(cols.length)}`];
    let used = table[0].length + table[1].length + 2;
    let taken = 0;
    for (const r of rows) {
      if (taken >= MAX_CHART_BLOCK_ROWS) break;
      const line = `${indent}| ${cols.map(c => cell(r[c])).join(' | ')} |`;
      if (used + line.length + 1 > allow) break;
      table.push(line);
      used += line.length + 1;
      taken++;
    }
    budget -= used;
    if (!taken) return note(config, '답변에 실을 수 있는 표의 양을 넘었습니다', indent);
    const block = `${indent}\`\`\`chart\n${[...kept, ...table].join('\n')}\n${indent}\`\`\``;
    // 행 상한이나 예산에 걸려 다 싣지 못한 표는 그 사실을 차트 아래 밝힌다 — 그래프만 보면 그것이 전부로 읽힌다.
    return taken < rows.length ? `${block}\n${indent}_(표는 ${rows.length}행 중 처음 ${taken}행까지만 실었습니다)_` : block;
  });
}
