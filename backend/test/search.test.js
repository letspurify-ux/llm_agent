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

test('토큰 상한은 조사 변형이 아니라 낱말에 걸린다', () => {
  // 확장된 토큰 목록을 자르면 상한이 앞쪽 낱말의 변형들로 소진되어(낱말 하나가 최대 3개를
  // 차지한다) 질문 뒤쪽의 구체적인 낱말이 SQL에 아예 실리지 않는다. 쿼리는 그대로 성공하므로
  // 오류가 남지 않고, 일반적인 앞부분 낱말로만 점수가 매겨져 엉뚱한 지식이 위로 올라온다.
  const lead = new Array(29).fill(0).map((_, i) => `앞말${i}이란`);
  const tokens = searchTokens([...lead, '가상계측'].join(' '));
  assert.ok(tokens.includes('가상계측'), '질문 끝의 낱말이 앞쪽 낱말의 변형에 밀려 사라졌다');
  assert.ok(tokens.length > 50, '이 입력은 확장 뒤 상한(50)을 넘겨야 회귀를 잡는다');

  // 상한 자체는 그대로다 — CASE 절 수천 개짜리 SQL은 MariaDB thread stack overrun을 낸다.
  const many = searchTokens(new Array(200).fill(0).map((_, i) => `낱말${i}이란`).join(' '));
  assert.ok(many.length <= 90, `토큰이 유계가 아니다: ${many.length}`);
});

test('2자 미만과 중복은 버린다', () => {
  assert.deepStrictEqual(searchTokens('a ? !! 배치 배치'), ['배치']);
  assert.deepStrictEqual(searchTokens(''), []);
  assert.deepStrictEqual(searchTokens('???'), []);
});
