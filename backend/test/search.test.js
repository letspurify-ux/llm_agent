// 검색 경계 회귀 테스트 — 실행: npm test
// 검색은 벡터 단일 경로다(search.js 머리말). 그래서 '검색이 성립하지 않았다'(null)와 '찾았는데 없다'([])의
// 구분이 이 파일의 유일한 계약이고, 그 구분이 무너지면 모델은 '등록된 자료가 없다'고 조용히 단정한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { searchKnowledge, searchQaMethods, searchQueries, warmUpEmbedding, SEARCH_COLUMNS } from '../src/search.js';

test('임베딩이 설정되지 않았으면 검색은 null(검색 불가)이고 관리 DB를 건드리지 않는다', async () => {
  // DB 풀이 없는 환경에서 돈다 — 검색이 DB를 만지면 여기서 접속 오류로 죽는다. 빈 배열을 돌려주면 안 된다:
  // 그것은 '찾았는데 없다'이고, 호출부(agent.js)는 그 둘을 다르게 기록한다.
  const saved = process.env.EMBEDDING_URL;
  delete process.env.EMBEDDING_URL;
  try {
    assert.equal(await searchKnowledge('배치 재시작'), null);
    assert.equal(await searchQaMethods('배치 재시작'), null);
    assert.equal(await searchQueries('배치 재시작'), null);
    assert.equal(await warmUpEmbedding(), false, '미설정이면 예열도 하지 않는다');
  } finally {
    if (saved !== undefined) process.env.EMBEDDING_URL = saved;
  }
});

test('빈 검색어는 검색 불가가 아니라 0건이다', async () => {
  // 빈 입력을 임베딩 서버에 보내면 거부되어 '검색 불가'로 기록된다 — 정상 경로에서는 오지 않지만
  // (agent.js가 빈 검색어를 질문으로 대신한다) 이 경계는 스스로 그것을 가려야 한다.
  const saved = process.env.EMBEDDING_URL;
  process.env.EMBEDDING_URL = 'http://127.0.0.1:9';   // 닿지 않는 주소 — 빈 검색어는 여기까지 가면 안 된다
  try {
    assert.deepEqual(await searchKnowledge('   '), []);
    assert.deepEqual(await searchQueries(undefined), []);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_URL; else process.env.EMBEDDING_URL = saved;
  }
});

test('임베딩 원문 컬럼은 세 소스 모두 제목/이름이 첫 컬럼이다', () => {
  // embed-sync.js가 이 정의로 원문을 만든다 — 첫 컬럼이 제목이어야 짧은 제목 매칭이 본문에 묻히지 않는다.
  assert.deepEqual(Object.keys(SEARCH_COLUMNS), ['knowledge', 'qa_method', 'query_registry']);
  assert.equal(SEARCH_COLUMNS.knowledge[0], 'title');
  assert.equal(SEARCH_COLUMNS.qa_method[0], 'title');
  assert.equal(SEARCH_COLUMNS.query_registry[0], 'query_name');
});
