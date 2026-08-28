// 지식/Q&A처리방법 검색.
// 검색 구현은 이 파일에만 있다 — 향후 vector 검색으로 전환할 때 이 두 함수 내부만 교체한다.
import { query } from './db.js';

const LIMIT = 20;         // LLM에 넘길 최대 후보 수 (건당 약 84토큰)
const TITLE_WEIGHT = 3;   // 제목 매칭은 본문 매칭보다 높게 — 제목이 문서의 주제를 나타낸다

export function searchKnowledge(question) {
  return likeSearch('knowledge', ['title', 'content'], question);
}

export function searchQaMethods(question) {
  return likeSearch('qa_method', ['title', 'method'], question);
}

// 질문을 토큰으로 나눠 LIKE 매칭하고, 관련도 점수 순으로 상위 LIMIT건을 돌려준다.
// 점수 = Σ (컬럼 가중치 × 토큰 길이)
//   - 여러 토큰이 맞을수록, 제목에 맞을수록, 긴(구체적인) 토큰이 맞을수록 높다
//   - 조사를 뗀 변형 토큰은 원형보다 짧으므로 자연히 낮게 반영된다
async function likeSearch(table, columns, question) {
  const tokens = [...new Set(question.split(/\s+/).flatMap(expandToken).filter(t => t.length >= 2))];
  if (tokens.length === 0) return [];

  const scoreParts = [];
  const params = [];
  for (const tok of tokens) {
    columns.forEach((col, i) => {
      const weight = (i === 0 ? TITLE_WEIGHT : 1) * tok.length;
      scoreParts.push(`CASE WHEN ${col} LIKE ? THEN ${weight} ELSE 0 END`);
      params.push(`%${tok}%`);
    });
  }

  // LIKE '%...%'는 인덱스를 못 쓰므로 WHERE로 거르나 HAVING으로 거르나 비용이 같다.
  // 점수를 한 번만 계산하도록 HAVING을 쓴다 (파라미터 중복 없음).
  return query(
    `SELECT *, ${scoreParts.join(' + ')} AS _score FROM ${table}
     HAVING _score > 0 ORDER BY _score DESC, seq LIMIT ${LIMIT}`,
    params
  );
}

// 한국어는 조사가 붙어("가상계측이") 원형("가상계측")과 LIKE 매칭이 되지 않는다.
// 3자 이상 토큰은 끝 1~2글자를 뗀 형태도 함께 검색해 조사를 흡수한다.
function expandToken(token) {
  const variants = [token];
  if (/[가-힣]$/.test(token)) {
    if (token.length >= 3) variants.push(token.slice(0, -1));
    if (token.length >= 5) variants.push(token.slice(0, -2));
  }
  return variants;
}
