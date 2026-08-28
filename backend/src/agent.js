// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → 지식/처리방법 검색 → LLM 결정 루프(답변 또는 쿼리 실행) → 최종 답변.
// 루프의 유일한 상태는 history 배열이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
import { searchKnowledge, searchQaMethods } from './search.js';
import { loadQueryRegistry } from './db.js';
import { runQuery } from './oracle.js';
import { llm } from './llm.js';

const MAX_STEPS = 5;
const MAX_RESULT_ROWS = 20; // LLM 컨텍스트/답변에 전달할 최대 행 수 (총 건수는 totalRows로 보존)
const MAX_CELL_LEN = 200;   // 셀 값 최대 길이 (CLOB 등 대형 텍스트 방어)

function capRows(rows) {
  return rows.slice(0, MAX_RESULT_ROWS).map(row =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        const s = typeof v === 'string' ? v : null;
        return [k, s && s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + '…(생략)' : v];
      })
    )
  );
}

export async function handleQuestion(question) {
  const [knowledge, qaMethods, queries] = await Promise.all([
    searchKnowledge(question),
    searchQaMethods(question),
    loadQueryRegistry(),
  ]);

  const history = [];
  const ctx = () => ({ question, knowledge, qaMethods, queries, history });

  for (let step = 0; step < MAX_STEPS; step++) {
    const decision = await llm.decide(ctx());
    if (decision.action === 'answer') {
      return { answer: decision.answer, trace: history };
    }

    const registryRow = queries.find(q => q.query_name === decision.query_name);
    if (!registryRow) {
      history.push({ query_name: decision.query_name, params: decision.params, error: '등록되지 않은 쿼리' });
      continue;
    }
    try {
      const rows = await runQuery(registryRow, decision.params);
      history.push({
        query_name: registryRow.query_name,
        params: decision.params,
        rows: capRows(rows),
        totalRows: rows.length,
      });
    } catch (e) {
      // 실패도 이력에 남기고 루프를 계속한다 — LLM이 에러를 보고 재시도/우회/답변을 판단
      history.push({ query_name: registryRow.query_name, params: decision.params, error: e.message });
    }
  }

  // 안전장치: MAX_STEPS 초과 시 강제 답변
  const final = await llm.decide({ ...ctx(), forceAnswer: true });
  return { answer: final.answer, trace: history };
}
