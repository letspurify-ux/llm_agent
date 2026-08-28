// 지식/Q&A처리방법 검색.
// 검색 구현은 이 파일에만 있다 — 향후 vector 검색으로 전환할 때 이 두 함수 내부만 교체한다.
import { query } from './db.js';

export function searchKnowledge(question) {
  return likeSearch('knowledge', ['title', 'content'], question);
}

export function searchQaMethods(question) {
  return likeSearch('qa_method', ['title', 'method'], question);
}

// 질문을 공백으로 분리 → 2자 이상 토큰 → 컬럼별 LIKE '%tok%' OR 결합 → 최대 5건
async function likeSearch(table, columns, question) {
  const tokens = [...new Set(question.split(/\s+/).flatMap(expandToken).filter(t => t.length >= 2))];
  if (tokens.length === 0) return [];

  const conditions = [];
  const params = [];
  for (const tok of tokens) {
    for (const col of columns) {
      conditions.push(`${col} LIKE ?`);
      params.push(`%${tok}%`);
    }
  }
  return query(
    `SELECT * FROM ${table} WHERE ${conditions.join(' OR ')} ORDER BY seq LIMIT 5`,
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
