// Oracle 실행기 가드 회귀 테스트 — 실행: npm test
// ORACLE_MOCK=1 경로만 사용한다 (실 DB 불필요). 실행 전 가드(bindProblem)와 mock 조회는
// 실제 접속 여부와 무관하게 같은 코드를 타므로 여기서 검증하는 판정이 실배포에도 그대로 적용된다.
import { test } from 'node:test';
import assert from 'node:assert';
import { runQuery } from '../src/oracle.js';
import { MAX_CELL_LEN, TRUNC_MARK } from '../src/constants.js';

process.env.ORACLE_MOCK = '1';

const reg = (name, sql = 'SELECT 1 FROM DUAL') => ({ query_name: name, query_sql: sql, target_db_name: 'D' });
const withBind = sql => reg('batch_job_status', 'SELECT 1 FROM T WHERE A = :job_id');

test('프로토타입 멤버와 겹치는 쿼리 이름도 safe 안내로 실패한다', async () => {
  // 'constructor'가 프로토타입 체인을 타면 !gen 가드를 지나쳐 unsafe TypeError로 죽는다 —
  // 사용자에게는 일반 오류 문구, 모델에게는 드라이버 오류처럼 보여 양쪽 다 원인을 잃는다.
  for (const name of ['constructor', '__proto__']) {
    await assert.rejects(
      runQuery(reg(name)),
      e => e.safe === true && /mock 데이터가 정의되지 않은 쿼리/.test(e.message),
      `${name}은 safe 안내로 실패해야 한다`
    );
  }
});

test('값 없는 바인드는 실행 전에 safe 오류로 거부된다', async () => {
  await assert.rejects(
    runQuery(withBind(), {}),
    e => e.safe === true && /값 없음/.test(e.message)
  );
  // 모델 전용 지침은 message가 아니라 hint에 실린다 — message는 사용자 trace에 그대로 나간다
  await assert.rejects(
    runQuery(withBind(), {}),
    e => !/선택하라|되물어/.test(e.message) && /확인하고/.test(e.hint)
  );
});

test('잘린 표시가 붙은 바인드 값은 실행 전에 거부된다', async () => {
  await assert.rejects(
    runQuery(withBind(), { job_id: `x${TRUNC_MARK}` }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
});

test('정확히 절단 길이인 값만 잘린 조각으로 의심한다', async () => {
  // 마크를 뗀 조각은 정확히 MAX_CELL_LEN자다 — 이력 밖(이전 턴 답변)에서 온 조각을 여기서 거른다.
  await assert.rejects(
    runQuery(withBind(), { job_id: 'x'.repeat(MAX_CELL_LEN) }),
    e => e.safe === true && /잘린 값/.test(e.message)
  );
  // 그보다 긴 값은 질문에서 온 정당한 입력일 수 있다 — 통과해야 한다 (mock은 0건을 돌려줄 뿐).
  // '이상'으로 잡으면 자유 검색어·경로 같은 긴 값으로는 등록 쿼리를 영영 실행할 수 없다.
  const r = await runQuery(withBind(), { job_id: 'x'.repeat(MAX_CELL_LEN + 50) });
  assert.deepStrictEqual(r.rows, []);
});

test('바인드명이 프로토타입 멤버와 겹쳐도 판정이 어긋나지 않는다', async () => {
  // params?.['__proto__']가 Object.prototype을 돌려주면 '값 없음'이 '값이 아닌 구조'로 둔갑한다
  await assert.rejects(
    runQuery(reg('batch_job_status', 'SELECT 1 FROM T WHERE A = :__proto__'), {}),
    e => e.safe === true && /값 없음/.test(e.message)
  );
});
