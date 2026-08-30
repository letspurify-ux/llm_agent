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
import { MAX_TRACE_ROWS } from './constants.js';
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

// 화면 trace 패널로 내보낼 형태. server.js가 아니라 여기 있는 이유가 둘이다.
//  ① 위 건수 해석을 쓰는 세 번째 대상이 바로 이 패널이다. 해석과 표시가 갈라져 있었다 —
//     패널은 rowCount로 총 건수(최대 100)를 말하면서 행은 말없이 10건만 실어, 사용자가 그
//     10건을 전부로 읽었다. 답변 본문(llm.js)은 같은 기록에 '외 N건 생략'을 붙이고 있었다.
//     몇 건을 감췄는지 함께 내보내고 문구는 화면이 만든다 — 해석은 하나, 문구는 대상마다.
//  ② 드라이버·DB 원문을 화면에서 가리는 판정(h.safe)이 여기 들어 있다. 서버 파일 안에 두면
//     import만으로 서버가 떠서 회귀 테스트를 붙일 수 없고, 그러면 이 필터가 조용히 깨져도
//     드러나지 않는다 — 깨진 결과가 스키마명·접속 주소의 화면 노출이라 특히 그렇다.
export function clientTrace(trace) {
  // note만 있는 항목은 루프 가드가 LLM에게 남긴 제어용 기록이고 실행된 쿼리가 아니다 —
  // '실행된 쿼리 N건' 목록에서 제외한다 (내부 지시문이 사용자에게 노출되지 않게).
  return trace.filter(h => !h.note).map(h => {
    const { rows, totalRows, capped } = rowCounts(h);
    // 오류 기록에는 rows 자체가 없다 — 빈 배열로 바꾸면 화면이 '0건 조회 성공'으로 읽는다.
    const shown = h.rows ? rows.slice(0, MAX_TRACE_ROWS) : undefined;
    return {
      query_name: h.query_name,
      params: h.params,
      rowCount: capped ? `${totalRows}+` : totalRows,
      rows: shown,
      // 실린 행보다 조회된 건수가 많을 때만 붙인다 (평소 패널은 지금과 똑같이 조용하다).
      ...(shown && totalRows > shown.length && { omittedRows: totalRows - shown.length }),
      // 드라이버·DB가 던진 원문은 스키마명·테이블명·접속 주소를 담고 있다 —
      // 화면에는 우리가 문구를 만든 오류(h.safe)만 내보내고 원문은 로그와 chat_log에만 남긴다.
      // (사용자에게 일반화된 문구만 주는 llm-openai.js와 같은 기준이다)
      ...(h.error && { error: h.safe ? h.error : '조회 중 오류가 발생했습니다.' }),
    };
  });
}
