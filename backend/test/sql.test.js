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

test('바인드 추출은 리터럴·주석 안의 콜론을 무시한다', () => {
  assert.deepStrictEqual(bindNames("SELECT TO_CHAR(d, 'HH24:MI') FROM t WHERE a = :job_id"), ['job_id']);
  assert.deepStrictEqual(bindNames('SELECT 1 FROM t WHERE a = :a /* :nope */ AND b = :b -- :nope2'), ['a', 'b']);
  assert.deepStrictEqual(bindNames("SELECT q'!don't!' a FROM t WHERE id = :id AND s = 'a;b'"), ['id']);
  assert.deepStrictEqual(bindNames('SELECT 1 FROM t WHERE a = :x AND b = :x'), ['x']); // 중복 제거
});
