// LIKE 검색 토큰화 회귀 테스트 — 실행: npm test
// 조사 제거(expandToken)는 /[가-힣]$/로 판정하므로 문장부호가 하나만 붙어도 변형이 전부 사라진다.
// 그러면 "가상계측이란?"이 0건이 되는데, 물음표는 한국어 질문에서 가장 흔한 입력이라
// 검색이 통째로 비는 것을 아무도 이상하게 보지 않는다.
import { test } from 'node:test';
import assert from 'node:assert';
import { searchTokens } from '../src/search.js';

test('앞뒤 문장부호를 떼고 조사 변형을 만든다', () => {
  assert.deepStrictEqual(searchTokens('가상계측이란?'), ['가상계측이란', '가상계측이', '가상계측']);
  assert.deepStrictEqual(searchTokens('가상계측이란'), ['가상계측이란', '가상계측이', '가상계측']);
  assert.ok(searchTokens('BATCH001? 상태').includes('BATCH001'));
  assert.ok(searchTokens('"배치", 상태!').includes('배치'));
});

test('토큰 가운데 부호는 식별자의 일부이므로 건드리지 않는다', () => {
  assert.ok(searchTokens('BATCH-001 상태').includes('BATCH-001'));
  assert.ok(searchTokens('restart_batch.sh 실행').includes('restart_batch.sh'));
});

test('2자 미만과 중복은 버린다', () => {
  assert.deepStrictEqual(searchTokens('a ? !! 배치 배치'), ['배치']);
  assert.deepStrictEqual(searchTokens(''), []);
  assert.deepStrictEqual(searchTokens('???'), []);
});
