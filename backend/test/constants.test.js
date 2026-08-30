// 공유 헬퍼 회귀 테스트 — 실행: npm test
// clipText/nameKey는 절단과 이름 비교가 일어나는 모든 곳(프롬프트·임베딩·조회 셀·루프 가드·mock)이
// 함께 쓴다. 여기가 어긋나면 어긋난 티가 나지 않는 자리에서 조용히 갈라진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { clipText, nameKey } from '../src/constants.js';

test('절단이 서로게이트 쌍을 쪼개지 않는다', () => {
  // 쪼개면 짝 잃은 코드유닛이 남아 JSON은 통과하지만 유효한 UTF-8이 아니게 된다 —
  // 임베딩 서버가 그 행만 매 주기 거부하거나, 프롬프트 본문이 조용히 훼손된다.
  const boundary = 'a'.repeat(9) + '😀' + 'b'.repeat(5); // 경계(10)에 4바이트 문자가 걸린다
  const cut = clipText(boundary, 10);
  assert.ok(cut.isWellFormed(), `짝 잃은 서로게이트가 남았다: ${JSON.stringify(cut)}`);
  assert.equal(cut, 'a'.repeat(9));
  assert.ok(clipText(boundary, 11).isWellFormed()); // 이모지가 온전히 들어가는 경계는 그대로
});

test('상한 이하는 원본 그대로 돌려준다', () => {
  assert.equal(clipText('abc', 10), 'abc');
  assert.equal(clipText('abcd', 4), 'abcd'); // 정확히 상한
  assert.equal(clipText('abcde', 4), 'abcd');
});

test('쿼리 이름 키는 대소문자와 앞뒤 공백을 무시한다', () => {
  // query_registry 조회가 대소문자를 구분하지 않으므로(schema.sql이 collation을 고정한다)
  // 이름으로 판정하는 모든 곳이 같은 키를 봐야 한다
  assert.equal(nameKey('BATCH_JOB_STATUS'), nameKey('batch_job_status'));
  assert.equal(nameKey('  batch_job_status  '), 'batch_job_status');
  assert.equal(nameKey(null), '');
  assert.equal(nameKey(undefined), '');
});
