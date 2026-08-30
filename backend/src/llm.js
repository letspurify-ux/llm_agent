// LLM 인터페이스 + provider 선택.
//
// 인터페이스는 함수 시그니처 하나가 전부다:
//   decide(ctx) → Promise<{action:'answer', answer}
//                        |{action:'run_query', query_name, params}>
//   ctx = {question, chat[], knowledge[], qaMethods[], queries[], history[], forceAnswer?}
//
// LLM_PROVIDER=openai 이면 vLLM/OpenRouter(OpenAI 호환 API), 아니면 규칙 기반 Mock.
// agent.js는 provider가 바뀌어도 변경되지 않는다.
import { openaiDecide } from './llm-openai.js';
import { bindNames } from './sql.js';
import { MAX_ROWS, TRUNC_MARK, nameKey } from './constants.js';
import { rowCounts } from './result.js';

export const llm = {
  decide(ctx) {
    return process.env.LLM_PROVIDER === 'openai' ? openaiDecide(ctx) : mockDecide(ctx);
  },
};

// ===== MockLLM: 규칙 기반 구현 (개발용) =====

async function mockDecide(ctx) {
  const { qaMethods, queries, history, forceAnswer } = ctx;

  // 쿼리 실행 중 에러가 났으면 더 진행하지 않고 답변으로 전환 (에러 내용 포함)
  const hasError = history.some(h => h.error);

  if (!forceAnswer && !hasError) {
    // 매칭된 qa_method 본문에 등장하는 순서대로 실행할 쿼리 계획 도출
    const planned = plannedQueries(qaMethods, queries);
    for (const q of planned) {
      // 이름 비교는 nameKey로 한다 — query_registry가 대소문자를 구분하지 않으므로
      // ===로 보면 철자만 다른 같은 쿼리를 '아직 실행 안 함'으로 읽고 매 스텝 다시 제안한다.
      if (history.some(h => nameKey(h.query_name) === nameKey(q.query_name) && h.rows)) continue;
      const params = fillParams(q, ctx);
      if (params) return { action: 'run_query', query_name: q.query_name, params };
      // 바인드 값을 채울 수 없는 쿼리는 건너뛴다 (이 질문과 무관한 쿼리로 간주)
    }
  }
  return { action: 'answer', answer: buildAnswer(ctx) };
}

function plannedQueries(qaMethods, queries) {
  const planned = [];
  for (const m of qaMethods) {
    // 본문의 표기와 등록 철자가 대소문자만 다를 수 있으므로 양쪽을 같은 기준으로 낮춰 찾는다
    const method = m.method.toLowerCase();
    const found = queries
      .map(q => ({ q, pos: method.indexOf(nameKey(q.query_name)) }))
      .filter(x => x.pos >= 0)
      .sort((a, b) => a.pos - b.pos);
    for (const { q } of found) {
      if (!planned.includes(q)) planned.push(q);
    }
  }
  return planned;
}

// mock 전용 하드코딩 규칙 — 실제 LLM은 질문 문맥에서 스스로 값을 추출한다.
const PARAM_RULES = {
  job_id: q => (q.match(/\b[A-Z]{2,}\d+\b/) || [])[0],
  customer_name: q => (q.match(/([가-힣]{2,4})\s*(?:고객|님)/) || [])[1],
};

// 바인드 값 채우기: ① 이전 쿼리 결과의 컬럼명 매칭(대소문자 무시) → multi-step 연결
//                  ② 현재 질문 → 최근 질문 순으로 정규식 추출 (후속 질문 대응)
//                  ③ 따옴표 문자열 fallback. 하나라도 못 채우면 null.
function fillParams(registryRow, ctx) {
  const params = {};
  // 현재 질문을 먼저 본다 — 이전 질문의 오래된 값이 현재 대상을 덮어쓰지 않도록.
  const texts = [ctx.question, ...(ctx.chat || []).filter(m => m.role === 'user').map(m => m.text).reverse()];

  for (const name of bindNames(registryRow.query_sql)) {
    let value = valueFromHistory(name, ctx.history);
    if (value === undefined && PARAM_RULES[name]) {
      for (const t of texts) {
        value = PARAM_RULES[name](t);
        if (value !== undefined) break;
      }
    }
    if (value === undefined) value = (ctx.question.match(/["']([^"']+)["']/) || [])[1];
    if (value === undefined) return null;
    params[name] = value;
  }
  return params;
}

function valueFromHistory(name, history) {
  for (let i = history.length - 1; i >= 0; i--) {
    for (const row of history[i].rows || []) {
      for (const [col, val] of Object.entries(row)) {
        // capRows가 자른 값은 원본이 아니므로 바인드 값으로 쓰지 않는다
        if (typeof val === 'string' && val.endsWith(TRUNC_MARK)) continue;
        if (col.toLowerCase() === name.toLowerCase()) return val;
      }
    }
  }
  return undefined;
}

// 답변 조립 (markdown 형식): 쿼리 실행 결과 요약 + 관련 지식 첨부
function buildAnswer({ knowledge, history }) {
  const parts = [];
  for (const h of history) {
    if (h.error) {
      parts.push(`**${h.query_name}** 실행 오류: ${h.error}`);
    } else if (h.rows?.length) {
      // 건수 해석은 rowCounts 한 곳에서만 한다 — 프롬프트(llm-openai.js)·화면 trace(server.js)가
      // 같은 기록을 각자 렌더하므로, 해석이 갈리면 사용자와 모델이 다른 건수를 보게 된다.
      const { rows, totalRows, omitted, capped } = rowCounts(h);
      const note = capped
        ? `\n\n_외 ${omitted}건 이상 생략 (조회 상한 ${MAX_ROWS}건 도달 — 실제는 더 많을 수 있음)_`
        : omitted > 0 ? `\n\n_외 ${omitted}건 생략 (총 ${totalRows}건)_` : '';
      parts.push(`### ${h.query_name} 조회 결과\n\n${rowsToMarkdownTable(rows)}${note}`);
    } else if (h.rows) {
      parts.push(`**${h.query_name}** 조회 결과가 없습니다.`);
    }
  }
  // 지식 첨부 규칙: 쿼리를 실행하지 않았으면 항상, 실행했으면 결과 값이 지식 내용에
  // 등장할 때만 첨부한다 (예: STATUS=FAILED ↔ "FAILED 상태이면 …" 지식).
  // 짧은 값은 매칭에서 뺀다 — ''는 모든 문자열에 포함되고(항상 참), 한 글자 값('Y', 등급 'A',
  // 상태코드 '1')은 어지간한 한국어 본문에 다 들어 있어 무관한 지식이 딸려온다.
  const MIN_MATCH_LEN = 2;
  // 기준은 "쿼리를 실행했는가"가 아니라 "조회가 성공했는가"다.
  //   조회가 전부 실패했으면(에러만 있음) 첨부한다 — 손에 든 지식 대신 드라이버 오류 문구만 남으면 안 된다.
  //   조회가 성공했으면 0건이어도 값 일치를 요구한다 — 여기서 무조건 첨부하면
  //   "BATCH999는 없습니다" 뒤에 존재하지도 않는 작업의 재시작 절차가 확신에 차서 붙는다.
  // (h.rows는 성공 시 빈 배열이라도 존재하므로 length가 아니라 유무로 판정한다)
  const querySucceeded = history.some(h => h.rows);
  const attach = knowledge.find(k =>
    !querySucceeded ||
    history.some(h => (h.rows || []).some(row =>
      Object.values(row).some(v => {
        const s = String(v ?? '');
        return s.length >= MIN_MATCH_LEN && k.content.includes(s);
      })
    ))
  );
  if (attach) {
    parts.push(`### 관련 지식: ${attach.title}\n\n${attach.content}`);
  }
  if (!parts.length) {
    // 등록된 지식/쿼리 결과가 전혀 없는 경우 — 실제 LLM은 자체 일반 지식으로 답변한다
    // (llm-openai.js 시스템 프롬프트 참고). Mock은 일반 지식이 없으므로 안내만 한다.
    return '*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n\n' +
      '(Mock LLM은 일반 지식이 없습니다 — 실제 LLM(vLLM/OpenRouter) 연결 시 이 자리에 모델의 기본 지식 답변이 표시됩니다.)';
  }
  return parts.join('\n\n');
}

// 셀 값에 든 '|'와 개행은 표 문법 그 자체다 — 그대로 흘리면 remark-gfm가 컬럼 수를 잘못 세어
// 그 행부터 값이 밀리거나(파이프), 표가 중간에 끊기고 나머지가 본문으로 렌더된다(개행).
// 역슬래시를 '먼저' 이스케이프해야 한다: 나중에 하면 'C:\|share'가 'C:\\|share'가 되어
// GFM이 '\\'를 역슬래시 한 글자로 읽고 그 뒤 '|'를 살아 있는 구분자로 처리한다 (막으려던 그 오정렬).
const cell = v => String(v ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/\r?\n/g, ' ');

function rowsToMarkdownTable(rows) {
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.map(cell).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${cols.map(c => cell(r[c])).join(' | ')} |`),
  ].join('\n');
}
