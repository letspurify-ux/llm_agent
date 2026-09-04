// context.md가 코드와 어긋나지 않는지 대조한다 — 실행: npm test
//
// 이 문서는 '상수 하나를 고칠 때 무엇을 함께 봐야 하는가'를 적어 둔 설계도다. 그런데 문서와 코드가
// 갈라지는 것은 이 저장소가 가장 나쁘게 보는 실패의 전형이다: 아무 오류도 없이, 다음 사람이 틀린 숫자를
// 근거로 판단한다. 예산 불변식을 로드 시점에 터뜨리는 것과 같은 이유로 여기서도 소리가 나게 한다.
//
// 재는 것은 숫자와 관계식뿐이다 — 문장을 다듬는 것까지 깨뜨리면 문서를 고치는 일이 벌이 된다.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as c from '../src/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const md = readFileSync(join(ROOT, 'context.md'), 'utf8');
const src = name => readFileSync(join(ROOT, 'backend', 'src', name), 'utf8');

// 이름이 나오는 '모든' 줄을 본다 — 상호참조 표에도 이름이 나오므로 한 줄만 보면 오탐이 난다.
const mentions = name => md.split('\n').filter(l => l.includes(`\`${name}\``));
const has = (name, v) => {
  const lines = mentions(name);
  assert.ok(lines.length, `${name}: context.md에 없다`);
  assert.ok(lines.some(l => l.includes(v.toLocaleString('en-US')) || l.includes(String(v))),
    `${name}: 문서 어디에도 코드 값(${v})이 없다`);
};

test('context.md의 상수 값이 constants.js와 같다', () => {
  for (const name of ['MAX_PROMPT_TOTAL_LEN', 'PROMPT_FRAME_RESERVE', 'MAX_PROMPT_ITEM_LEN', 'MAX_DOC_LEN',
    'MAX_PROMPT_SQL_LEN', 'MAX_PROMPT_STEP_LEN', 'MAX_PROMPT_PARAMS_LEN', 'MAX_SEARCHES', 'SEARCH_LIMIT',
    'MAX_STEPS', 'MAX_BATCH_QUERIES', 'MAX_EXPANDS', 'MAX_DROPS', 'MAX_HISTORY_ROWS', 'MAX_COMPLETION_TOKENS',
    'MAX_ANSWER_LEN', 'MAX_RESULT_ROWS', 'MAX_ROWS', 'MAX_QUESTION_LEN']) {
    has(name, c[name]);
  }
  for (const [k, v] of Object.entries(c.PROMPT_FLOORS)) has(`PROMPT_FLOORS.${k}`, v);
});

test('context.md의 몫 합계와 여유가 실제 값과 같다', () => {
  const sum = Object.values(c.PROMPT_FLOORS).reduce((a, b) => a + b, 0) + c.PROMPT_FRAME_RESERVE;
  assert.ok(md.includes(sum.toLocaleString('en-US')), `몫 합계 ${sum}이 문서에 없다`);
  assert.ok(md.includes(`여유 ${c.MAX_PROMPT_TOTAL_LEN - sum}자`), `여유가 문서와 다르다 (${c.MAX_PROMPT_TOTAL_LEN - sum}자)`);
  assert.ok(md.includes(`${c.MAX_CHAT_TURNS}턴 × ${c.MAX_CHAT_LEN.toLocaleString('en-US')}자 = ${(c.MAX_CHAT_TURNS * c.MAX_CHAT_LEN).toLocaleString('en-US')}자`),
    '대화 몫 계산이 문서와 다르다');
});

test('constants.js 밖에 있는 값도 문서와 같다', () => {
  const pick = (file, re, name) => {
    const m = re.exec(src(file));
    assert.ok(m, `${name}을 ${file}에서 찾지 못했다`);
    return Number(m[1].replace(/_/g, ''));
  };
  has('MAX_PROMPT_NAME_LEN', pick('llm-openai.js', /MAX_PROMPT_NAME_LEN = (\d+)/, 'MAX_PROMPT_NAME_LEN'));
  has('MAX_PROMPT_SHORT_DESC_LEN', pick('llm-openai.js', /MAX_PROMPT_SHORT_DESC_LEN = (\d+)/, 'MAX_PROMPT_SHORT_DESC_LEN'));
  has('MAX_PROMPT_SEARCH_LEN', pick('llm-openai.js', /MAX_PROMPT_SEARCH_LEN = (\d+)/, 'MAX_PROMPT_SEARCH_LEN'));
  has('MAX_SYSTEM_PROMPT_LEN', pick('llm-openai.js', /MAX_SYSTEM_PROMPT_LEN = (\d+)/, 'MAX_SYSTEM_PROMPT_LEN'));
  has('MAX_PROMPT_QUERIES', pick('agent.js', /MAX_PROMPT_QUERIES = (\d+)/, 'MAX_PROMPT_QUERIES'));
  has('DETAIL_TOP', pick('agent.js', /DETAIL_TOP = (\d+)/, 'DETAIL_TOP'));
  has('MAX_GUARD_HITS', pick('agent.js', /MAX_GUARD_HITS = (\d+)/, 'MAX_GUARD_HITS'));
  has('MAX_LOOP_MS', pick('agent.js', /MAX_LOOP_MS = ([\d_]+)/, 'MAX_LOOP_MS'));
  // 7-의 두 값. 종전에는 숫자로만 적혀 있어(‘표 30,000자 + 차트 30,000자’) 이 대조가 이름을 찾지 못했고,
  // 문서가 막겠다고 한 드리프트가 정확히 그 두 칸에 남아 있었다.
  has('MAX_TABLE_INJECT_LEN', pick('chart.js', /MAX_TABLE_INJECT_LEN = ([\d_]+)/, 'MAX_TABLE_INJECT_LEN'));
  has('MAX_CHART_INJECT_LEN', pick('chart.js', /MAX_CHART_INJECT_LEN = ([\d_]+)/, 'MAX_CHART_INJECT_LEN'));
});

// 사용자에게 나가는 답변의 천장은 세 상수의 합이다 — 어느 하나만 올리고 문서를 두면, 늘어난 답변이
// chat_log.answer(MEDIUMTEXT)에 들어가는지를 아무도 다시 계산하지 않는다.
test('context.md의 답변 천장이 세 상수의 합과 같다', async () => {
  const { MAX_TABLE_INJECT_LEN, MAX_CHART_INJECT_LEN } = await import('../src/chart.js');
  const n = v => v.toLocaleString('en-US');
  const cap = c.MAX_ANSWER_LEN + MAX_TABLE_INJECT_LEN + MAX_CHART_INJECT_LEN;
  assert.ok(md.includes(`= **${n(cap)}자**`), `답변 천장이 문서와 다르다 (${n(cap)}자)`);
});

test('context.md가 말하는 관계식이 코드에서도 참이다', () => {
  assert.equal(c.MAX_HISTORY_ROWS, c.MAX_STEPS + c.MAX_SEARCHES + 1, '이력 줄 수 식이 문서와 다르다');
  assert.ok(c.MAX_EXPANDS * c.MAX_DOC_LEN < c.PROMPT_FLOORS.knowledge, '펼침 총량이 지식 몫을 넘는다');
  assert.deepStrictEqual(c.ITEM_PREFIX, { knowledge: 'k', qaMethods: 'm' }, '식별자 접두사가 문서와 다르다');
  // 프롬프트 블록의 순서 — 문서의 표와 실제 조립 순서가 같아야 한다
  const order = ['관련 지식', 'Q&A 처리 방법', '실행 가능한 쿼리 목록', '실행 이력 (검색·쿼리)', '최근 대화', '사용자 질문 (현재)'];
  const build = src('llm-openai.js');
  const at = order.map(h => build.indexOf(`section('${h}'`) >= 0 ? build.indexOf(`section('${h}'`) : build.indexOf(h));
  assert.ok(at.every(i => i >= 0), `프롬프트 섹션 제목이 코드에 없다: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at, '코드의 조립 순서가 문서의 표와 어긋난다');
  const docAt = order.map(h => md.indexOf(h));
  assert.deepStrictEqual([...docAt].sort((a, b) => a - b), docAt, '문서의 섹션 순서가 어긋났다');
});

// 예산 '밖의' 몫도 전부 상한이 있어야 한다는 것이 3-3의 주장이다. 시스템 프롬프트만 오래도록 관측값이어서
// 규칙 한 줄을 더할 때마다 조용히 자랐고, 문서는 실제의 절반도 안 되는 값(~2k자, 실측 4.9k자)을 싣고
// 있었다. 상한 자체는 llm-openai.js가 로드 시 검증하므로(import만으로 터진다) 여기서는 '문서가 그 상한을
// 합계에 넣었는가'를 잰다 — 세 몫 중 하나라도 빠지면 최악 합계가 근거를 잃는다.
test('context.md의 최악 합계가 예산 밖의 몫을 전부 더한 값이다', async () => {
  const { MAX_SYSTEM_PROMPT_LEN } = await import('../src/llm-openai.js'); // 로드가 곧 시스템 프롬프트 상한 검증이다
  const outside = c.MAX_CHAT_TURNS * c.MAX_CHAT_LEN + c.MAX_QUESTION_LEN + MAX_SYSTEM_PROMPT_LEN;
  const worst = c.MAX_PROMPT_TOTAL_LEN + outside;
  const n = v => v.toLocaleString('en-US');
  assert.ok(md.includes(`${n(c.MAX_PROMPT_TOTAL_LEN)} + ${n(c.MAX_CHAT_TURNS * c.MAX_CHAT_LEN)} + ${n(c.MAX_QUESTION_LEN)} + ${n(MAX_SYSTEM_PROMPT_LEN)} = **${n(worst)}자**`),
    `최악 합계가 문서와 다르다 (${n(worst)}자)`);
});

// 이력 몫의 검증은 '어떤 조합으로든'이어야 한다 — 개수가 묶여 있는 것은 쿼리 결과·오류 줄뿐이고,
// 검색 가드 줄(중복 검색·횟수 상한)은 searches를 올리지 않아 검색 모양 줄이 MAX_SEARCHES를 넘을 수 있다.
// 그래서 문서(4-·5-)와 코드가 모두 '쿼리 MAX_STEPS줄 + 나머지'로 잡는다. 종전의 조합별 회계로 되돌아가면
// 이 테스트가 막는다 — 되돌아가도 지금 값에서는 통과하므로(검색 줄이 더 짧다) 아무 데서도 드러나지 않는다.
test('이력 몫은 줄의 조합과 무관하게 검증된다', () => {
  const src2 = readFileSync(join(ROOT, 'backend', 'src', 'llm-openai.js'), 'utf8');
  assert.match(src2, /const OTHER_ROWS = MAX_HISTORY_ROWS - MAX_STEPS;/,
    '이력 몫 검증이 모양별 개수를 다시 세고 있다 (context.md 4-)');
  assert.ok(!/MAX_SEARCHES \* \(maxSearchLineLen/.test(src2),
    '이력 몫 검증이 검색 줄을 MAX_SEARCHES개로 세고 있다 — 그 개수는 묶여 있지 않다');
});
