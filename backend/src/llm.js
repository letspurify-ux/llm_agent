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
import { bindNames } from './oracle.js';

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
      if (history.some(h => h.query_name === q.query_name && h.rows)) continue; // 이미 성공 실행
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
    const found = queries
      .map(q => ({ q, pos: m.method.indexOf(q.query_name) }))
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
      const omitted = (h.totalRows ?? h.rows.length) - h.rows.length;
      parts.push(
        `### ${h.query_name} 조회 결과\n\n${rowsToMarkdownTable(h.rows)}` +
        (omitted > 0 ? `\n\n_외 ${omitted}건 생략 (총 ${h.totalRows}건)_` : '')
      );
    } else if (h.rows) {
      parts.push(`**${h.query_name}** 조회 결과가 없습니다.`);
    }
  }
  // 지식 첨부 규칙: 쿼리를 실행하지 않았으면 항상, 실행했으면 결과 값이 지식 내용에
  // 등장할 때만 첨부한다 (예: STATUS=FAILED ↔ "FAILED 상태이면 …" 지식).
  const attach = knowledge.find(k =>
    history.length === 0 ||
    history.some(h => (h.rows || []).some(row =>
      Object.values(row).some(v => k.content.includes(String(v)))
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

function rowsToMarkdownTable(rows) {
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${cols.map(c => r[c]).join(' | ')} |`),
  ].join('\n');
}
