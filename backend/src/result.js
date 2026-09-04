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

// 화면 trace 패널로 내보낼 형태. server.js가 아니라 여기 있는 이유가 둘이다.
//  ① 위 건수 해석을 쓰는 세 번째 대상이 바로 이 패널이다. 해석과 표시가 갈라져 있었다 —
//     패널은 rowCount로 총 건수(최대 100)를 말하면서 행은 말없이 10건만 실어, 사용자가 그
//     10건을 전부로 읽었다. 답변 본문(llm.js)은 같은 기록에 '외 N건 생략'을 붙이고 있었다.
//     몇 건을 감췄는지 함께 내보내고 문구는 화면이 만든다 — 해석은 하나, 문구는 대상마다.
//  ② 드라이버·DB 원문을 화면에서 가리는 판정(h.safe)이 여기 들어 있다. 서버 파일 안에 두면
//     import만으로 서버가 떠서 회귀 테스트를 붙일 수 없고, 그러면 이 필터가 조용히 깨져도
//     드러나지 않는다 — 깨진 결과가 스키마명·접속 주소의 화면 노출이라 특히 그렇다.
//
// 행은 조회된 전부(fullRows, ≤MAX_ROWS)를 싣는다. 모델은 결과를 20행까지만 보고 그중 몇 행만 답변에
// 옮겨 적으므로, 사용자가 조회 결과 전체를 볼 수 있는 자리는 이 패널뿐이다. 크기는 드라이버 경계가
// 이미 세 축(행 MAX_ROWS·열 MAX_RESULT_COLS·셀 MAX_CELL_LEN)으로 묶어 두었고 스텝 수(MAX_STEPS)가 곱해질
// 뿐이라 여기서 다시 자르지 않는다 — 자르면 '전체를 보는 자리'가 다시 표본이 된다.
// fullRows는 agent.js가 history 항목을 키로 든 Map이다(성공한 조회에만 있다). 없는 항목은 history의
// 20행으로 물러나고, 그때는 omittedRows로 몇 건을 못 실었는지 알린다 — 조용히 표본이 되지 않게.
export function clientTrace(trace, fullRows = new Map()) {
  // note만 있는 항목은 루프 가드가 LLM에게 남긴 제어용 기록이고 실행된 검색·쿼리가 아니다 —
  // 패널의 목록에서 제외한다 (내부 지시문이 사용자에게 노출되지 않게).
  //
  // 다만 번호는 이력의 절대 순번을 그대로 실어 보낸다. 모델이 보는 번호(llm-openai.js renderHistory의 'N.')는
  // 제외된 항목까지 세므로, 화면이 남은 것만 1부터 다시 세면 답변이 "3번 조회 결과"라고 말할 때 사용자가
  // 패널에서 세는 3번과 다른 것을 가리킨다. 표·차트 참조는 서버가 채워서 안전하지만 답변 본문의 말은 그렇지 않다.
  return trace.map((h, i) => [h, i + 1]).filter(([h]) => !h.note).map(([h, step]) => {
    // 검색 기록 — 검색어·대상·대상별 적중 수. 답을 기다리는 동안 화면에 흘러간 것과 같은 값이 답이 온 뒤에도
    // 패널에 남는다 (agent.js의 search_done 이벤트와 같은 재료). failed는 '검색 불가'였던 대상이다 —
    // 0건과 구분해 보여야 사용자가 '등록이 없다'로 읽지 않는다.
    if (h.search !== undefined) {
      return { step, search: h.search, targets: h.targets ?? [], hits: h.hits ?? {}, ...(h.failed?.length && { failed: h.failed }) };
    }
    const { rows, totalRows, capped } = rowCounts(h);
    // 오류 기록에는 rows 자체가 없다 — 빈 배열로 바꾸면 화면이 '0건 조회 성공'으로 읽는다.
    const shown = h.rows ? (fullRows.get(h) ?? rows) : undefined;
    return {
      step,
      query_name: h.query_name,
      params: h.params,
      // 어느 DB를 조회했는지 화면에도 보여준다. 대상 DB가 여럿인 쿼리에서는 '무엇을 조회했나'의
      // 절반이 이 이름이다 — 같은 쿼리·같은 파라미터라도 DB가 다르면 다른 답이므로, 빼면
      // 사용자는 서울 재고와 부산 재고를 구분할 수 없는 trace를 보게 된다.
      // 등록 철자 그대로 나가므로 db_name에는 계정·호스트가 아니라 사람이 읽을 이름을 등록할 것
      // (접속 주소·계정은 target_db의 다른 컬럼이고 화면에 나가지 않는다).
      ...(h.targetDb && { targetDb: h.targetDb }),
      rowCount: capped ? `${totalRows}+` : totalRows,
      // 상한(MAX_ROWS)에 걸린 결과는 실린 행이 전부가 아니다 — rowCount의 '+'만으로는 화면이 그 뜻을
      // 문구로 풀어 줄 수 없어 따로 표시한다.
      ...(capped && { capped: true }),
      rows: shown,
      // 실린 행보다 조회된 건수가 많을 때만 붙인다 (전체 행이 실린 평소에는 붙지 않는다).
      ...(shown && totalRows > shown.length && { omittedRows: totalRows - shown.length }),
      // 드라이버·DB가 던진 원문은 스키마명·테이블명·접속 주소를 담고 있다 —
      // 화면에는 우리가 문구를 만든 오류(h.safe)만 내보내고 원문은 로그와 chat_log에만 남긴다.
      // (사용자에게 일반화된 문구만 주는 llm-openai.js와 같은 기준이다)
      ...(h.error && { error: h.safe ? h.error : '조회 중 오류가 발생했습니다.' }),
    };
  });
}
