// 조회 전용 가드(sql.js) 회귀 테스트 — 실행: npm test
// 이 가드는 등록된 SQL이 실제 Oracle로 나가기 전 마지막 방어선이므로, 리터럴 경계 판정이
// 어긋나면 두 방향 모두로 조용히 깨진다: 진짜 세미콜론을 놓치거나(우회), 정상 쿼리를 거부한다(오탐).
import { test } from 'node:test';
import assert from 'node:assert';
import { assertReadOnly, bindNames } from '../src/sql.js';

const rejects = sql => assert.throws(() => assertReadOnly(sql), Error, `허용되면 안 됨: ${sql}`);
const accepts = sql => assert.doesNotThrow(() => assertReadOnly(sql), `거부되면 안 됨: ${sql}`);

test('다중 문장과 비조회 문장을 거부한다', () => {
  rejects('SELECT 1 FROM dual; DELETE FROM t');
  rejects('DELETE FROM t');
  rejects('UPDATE t SET a = 1');
  rejects('BEGIN NULL; END;');
});

test('q-quote 구분자가 무엇이든 리터럴 경계를 정확히 잡는다', () => {
  // 구분자를 일부만 아는 파서는 아래에서 세미콜론을 리터럴로 삼켜 통과시킨다
  rejects("SELECT q'!don't!' FROM dual; DELETE FROM t WHERE a = q'!x!'");
  rejects("SELECT q'#it's#' FROM dual; DROP TABLE t");
  rejects("SELECT q'|a|' FROM dual; TRUNCATE TABLE t");
  // 반대 방향: 리터럴 안의 세미콜론을 문장 구분자로 오판하면 안 된다
  accepts("SELECT q'#it's; ok#' AS msg FROM dual");
  accepts("SELECT LISTAGG(name, '; ') FROM t");
  accepts("SELECT q'[a's]' FROM dual");
  accepts("SELECT nq'|it's|' FROM dual");
});

test('경계를 확정할 수 없는 SQL은 거부한다', () => {
  rejects("SELECT 'unterminated FROM t");
  rejects('SELECT /* unterminated FROM t');
});

test('정상 조회 쿼리는 통과한다', () => {
  accepts('SELECT 1 FROM dual');
  accepts('SELECT 1 FROM dual;');                       // 끝의 세미콜론 1개는 허용
  accepts('WITH x AS (SELECT 1 c FROM dual) SELECT * FROM x');
  accepts('-- comment; DELETE\nSELECT 1 FROM dual');
});

test('괄호로 시작하는 조회 쿼리도 통과한다', () => {
  // 등록 SQL이 `(SELECT …) FETCH FIRST n ROWS ONLY` 형태일 수 있다. 조회인데 거부되면 그 쿼리는
  // 영구히 죽고, 오류 문구가 "SELECT만 실행할 수 있다"라 원인이 정반대로 보인다.
  accepts('(SELECT ORDER_ID FROM ORDERS WHERE CUSTOMER_ID = :cid) FETCH FIRST 5 ROWS ONLY');
  accepts('( SELECT 1 FROM dual )');
  accepts('((SELECT 1 FROM dual))');
  // 괄호를 걷어낸 뒤에도 SELECT/WITH가 아니면 그대로 거부한다
  rejects('(DELETE FROM t)');
  rejects('(UPDATE t SET a = 1)');
  rejects('(SELECT 1 FROM dual); DROP TABLE t');
});

test('바인드 추출은 리터럴·주석 안의 콜론을 무시한다', () => {
  assert.deepStrictEqual(bindNames("SELECT TO_CHAR(d, 'HH24:MI') FROM t WHERE a = :job_id"), ['job_id']);
  assert.deepStrictEqual(bindNames('SELECT 1 FROM t WHERE a = :a /* :nope */ AND b = :b -- :nope2'), ['a', 'b']);
  assert.deepStrictEqual(bindNames("SELECT q'!don't!' a FROM t WHERE id = :id AND s = 'a;b'"), ['id']);
  assert.deepStrictEqual(bindNames('SELECT 1 FROM t WHERE a = :x AND b = :x'), ['x']); // 중복 제거
});

test('따옴표 식별자 안의 아포스트로피가 스캔을 어긋내지 않는다', () => {
  accepts(`SELECT "a'b" FROM t`);             // 아포스트로피를 담은 따옴표 식별자
  accepts(`SELECT 1 AS "a;b" FROM t`);        // 식별자 안의 세미콜론은 문장 구분자가 아니다
  accepts(`SELECT 1 FROM "my table"`);
  rejects(`SELECT 1 FROM "t"; DROP TABLE t`); // 식별자 밖의 세미콜론은 그대로 걸린다
  rejects('SELECT "unterminated FROM t');
  accepts(`SELECT 'a" b' FROM t`);            // 문자열 안의 따옴표는 문자열의 일부
});

test('행 잠금을 거는 조회(FOR UPDATE)는 거부한다', () => {
  // SELECT로 시작하는 단일 문장이라 다른 검사는 전부 통과한다 — 그런데 조회대상 DB의 행에
  // 잠금을 걸어 운영 트랜잭션을 대기시킨다. 화면에는 '조회 중 오류' 한 줄만 남아 원인이 안 보인다.
  rejects('SELECT * FROM orders WHERE id = :id FOR UPDATE');
  rejects('SELECT * FROM orders WHERE id = :id FOR UPDATE NOWAIT');
  rejects('SELECT * FROM orders WHERE id = :id FOR UPDATE SKIP LOCKED');
  rejects('SELECT * FROM orders WHERE id = :id FOR UPDATE OF status');
  rejects('SELECT * FROM orders\n  FOR\n  UPDATE');                 // 개행·들여쓰기
  rejects('SELECT * FROM orders FOR /* 주석 */ UPDATE');            // 주석은 공백으로 지워진다
  rejects('WITH x AS (SELECT 1 c FROM dual) SELECT * FROM x FOR UPDATE');

  // 오탐 방향: 리터럴·식별자 안의 표현은 코드가 아니므로 걸리면 안 된다
  accepts("SELECT 'FOR UPDATE' AS msg FROM dual");
  accepts('SELECT 1 AS "FOR UPDATE" FROM dual');
  accepts('-- FOR UPDATE 금지\nSELECT 1 FROM dual');
  accepts('SELECT for_update_yn FROM t');                            // 이름의 일부는 걸리지 않는다
});

// ===== 실행용 SQL (가드가 승인한 형태를 그대로 돌려준다) =====
// 가드와 실행부가 각자 문자열을 손보면 판단이 갈라진다. 실제로 갈라져 있었다: 가드는 주석을
// 지운 뒤 후행 ';'를 단일 문장으로 인정하는데 실행부는 원문에 /;\s*$/를 걸어, ';' 뒤에 주석이
// 붙는 순간 매치가 실패해 ';'가 드라이버로 나갔다. 결과는 서버 버전에 좌우된다 —
// Oracle 23ai는 받아주고 19c 이하는 ORA-00911로 거부하므로, 개발 컨테이너에서는 멀쩡하다가
// 운영 DB에서만 죽는다. mock은 SQL을 실행하지 않아 재현조차 되지 않는다.

test('가드가 허용한 후행 세미콜론은 실행용 SQL에서 사라진다', () => {
  assert.equal(assertReadOnly('SELECT 1 FROM dual;'), 'SELECT 1 FROM dual ');
  assert.equal(assertReadOnly('SELECT 1 FROM dual;\n'), 'SELECT 1 FROM dual \n');
  // ';' 뒤에 주석이 붙는 형태 — SQL 클라이언트에서 복사해 등록하면 흔하다
  assert.equal(assertReadOnly('SELECT 1 FROM dual; -- 복사본'), 'SELECT 1 FROM dual  -- 복사본');
  assert.equal(assertReadOnly('SELECT 1 FROM dual; /* 메모 */'), 'SELECT 1 FROM dual  /* 메모 */');
  assert.equal(assertReadOnly('SELECT 1 FROM dual;\n-- 메모\n'), 'SELECT 1 FROM dual \n-- 메모\n');
});

test('문장 끝이 아닌 세미콜론은 실행용 SQL에서 건드리지 않는다', () => {
  // 리터럴·식별자·주석 안의 ';'는 코드가 아니다 — 떼어내면 값이 바뀌거나 SQL이 깨진다.
  // 원문을 정규식으로 자르면 이 구분이 안 되므로 위치 판정은 스캐너 한 곳에서만 한다.
  for (const sql of [
    'SELECT 1 FROM dual',
    "SELECT LISTAGG(name, '; ') FROM t",
    "SELECT q'#it's; ok#' AS msg FROM dual",
    'SELECT 1 AS "a;b" FROM t',
    '-- comment; DELETE\nSELECT 1 FROM dual',
    '(SELECT ORDER_ID FROM ORDERS WHERE CUSTOMER_ID = :cid) FETCH FIRST 5 ROWS ONLY',
  ]) assert.equal(assertReadOnly(sql), sql, sql);
});

test('실행용 SQL은 그 자체로 다시 가드를 통과한다', () => {
  // 멱등성 — 가드가 내놓은 형태에 문장 구분자가 남아 있지 않다는 것을 가드 자신으로 확인한다.
  for (const sql of ['SELECT 1 FROM dual;', 'SELECT 1 FROM dual; -- 복사본', "SELECT LISTAGG(n, '; ') FROM t"]) {
    const exec = assertReadOnly(sql);
    assert.equal(assertReadOnly(exec), exec, sql);
  }
});

test('바인드 캐시는 가장 오래 "안 쓴" 것부터 밀어낸다', () => {
  // 삽입 순서만 보고 밀어내면(FIFO) 활성 SQL이 상한을 넘는 순간 방금 쓴 항목부터 차례로
  // 밀려나 적중률이 0에 수렴한다 — 오류 없이 파싱 비용만 매 요청 되돌아온다.
  // 캐시된 배열은 freeze된 같은 객체이므로 동일성으로 적중 여부를 본다.
  const hot = 'SELECT 1 FROM t WHERE a = :hot_bind';
  const cold = 'SELECT 1 FROM t WHERE a = :cold_bind';
  const hot0 = bindNames(hot);
  const cold0 = bindNames(cold);
  for (let i = 0; i < 1000; i++) {
    bindNames(hot);                                     // 계속 쓰는 SQL
    bindNames(`SELECT 1 FROM t WHERE a = :flood${i}`);   // 캐시를 밀어내는 유입
  }
  // 음성 대조 — 상한이 실제로 동작해 안 쓴 항목은 밀려난다 (아래 단언이 공허하지 않음을 보장)
  assert.notStrictEqual(bindNames(cold), cold0, '안 쓰는 SQL은 상한을 넘기면 밀려나야 한다');
  assert.strictEqual(bindNames(hot), hot0, '계속 쓰는 SQL은 남아야 한다 (FIFO면 밀려난다)');
});
