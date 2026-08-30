// 조회 결과 기록(agent history 항목)의 건수 해석.
//
// 같은 기록을 세 곳이 서로 다른 대상에게 렌더한다: 사용자 답변(llm.js), 모델 프롬프트(llm-openai.js),
// 화면 trace 패널(server.js). 문구는 대상마다 달라야 하지만 '몇 건 중 몇 건을 보여주고 있는가'라는
// 해석은 하나여야 한다 — 세 곳이 각자 `h.totalRows ?? rows.length`를 다시 유도하고 있어서
// MAX_RESULT_ROWS나 capped 의미를 바꿀 때 한 곳만 고치면 사용자와 모델이 다른 건수를 보게 된다.
//
// totalRows는 "드라이버가 실제로 받은 건수"(oracle.js MAX_ROWS 상한 적용 후)이고,
// rows는 그중 프롬프트·답변에 싣는 몫(agent.js MAX_RESULT_ROWS)이다. 둘은 다를 수 있다.
// capped=true면 totalRows 자체가 상한에 걸린 값이라 실제 총 건수는 더 많을 수 있다.
export function rowCounts(h) {
  // rows가 없는 기록(오류, 또는 오류 메시지가 비어 분기를 빠져나온 기록)에도 죽지 않아야 한다 —
  // 여기서 던지면 프롬프트 조립이 통째로 실패해 이미 조회해둔 결과까지 버려진다.
  const rows = h.rows ?? [];
  const totalRows = h.totalRows ?? rows.length;
  return {
    rows,
    shown: rows.length,
    totalRows,
    omitted: Math.max(0, totalRows - rows.length),
    capped: Boolean(h.capped),
  };
}
