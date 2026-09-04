// 검색 경계 회귀 테스트 — 실행: npm test
// 검색은 벡터 단일 경로다(search.js 머리말). 그래서 '검색이 성립하지 않았다'(null)와 '찾았는데 없다'([])의
// 구분이 이 파일의 유일한 계약이고, 그 구분이 무너지면 모델은 '등록된 자료가 없다'고 조용히 단정한다.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { searchKnowledge, searchQaMethods, searchQueries, warmUpEmbedding, SEARCH_COLUMNS, vecTable, CHUNK_OVERFETCH } from '../src/search.js';

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
  // 지식은 원문(knowledge)이 아니라 청크를 검색한다 — 원문은 임베딩 상한에서 잘려 앞부분만 벡터가
  // 되므로 긴 문서의 뒷부분이 어떤 검색어로도 걸리지 않았다 (chunk.js 머리말).
  assert.deepEqual(Object.keys(SEARCH_COLUMNS), ['knowledge_chunk', 'qa_method', 'query_registry']);
  assert.equal(SEARCH_COLUMNS.knowledge_chunk[0], 'title');
  assert.equal(SEARCH_COLUMNS.qa_method[0], 'title');
  assert.equal(SEARCH_COLUMNS.query_registry[0], 'query_name');
});

// 임베딩 테이블 이름은 규칙 하나로 파생한다 — 매핑 표를 따로 들면 소스를 더할 때 한쪽만 고쳐지고,
// 그 실패는 '검색 불가'로만 보여 원인을 가리키지 않는다 (schema.sql의 vec_* 이름과 같은 규칙).
test('임베딩 테이블 이름이 소스마다 따로 파생된다', () => {
  for (const src of Object.keys(SEARCH_COLUMNS)) assert.equal(vecTable(src), `vec_${src}`);
  assert.equal(new Set(Object.keys(SEARCH_COLUMNS).map(vecTable)).size, Object.keys(SEARCH_COLUMNS).length,
    '두 소스가 같은 임베딩 테이블을 쓰면 서로의 벡터를 지운다');
});

// 지식 검색은 '청크'를 받아 '문서'로 접는다. 한 문서가 적중을 독차지하면 청크 20건이 문서 1건으로
// 접히고, 다른 문서는 후보에 오르지도 못한 채 사라진다 — 오류 없이 지식 절반이 안 보이는 상태다.
// 실측: 청크 20건을 받으면 문서 1개, 60건을 받으면 문서 9개였다.
//
// 배수를 '안쪽' 질의에 걸면 아무 일도 하지 않는다는 것도 함께 잰다: 바깥의 거리 필터는 거리 순서와
// 단조라 상위 60건을 걸러 20건을 취하나 상위 20건을 걸러 취하나 결과가 같다. 그래서 배수는
// '병합 뒤 몇 항목이 남는가'에 걸려야 하고, 그 자리는 바깥 상한이다.
test('지식 검색은 문서 상한보다 많은 청크를 받는다 — 병합이 항목 수를 줄이므로', async () => {
  assert.ok(CHUNK_OVERFETCH >= 2, '배수가 1이면 한 문서가 후보를 독차지할 때 다른 문서가 통째로 사라진다');
  const src = readFileSync(new URL('../src/search.js', import.meta.url), 'utf8');
  const fn = /export async function searchKnowledge[\s\S]*?\n}/.exec(src)[0];
  assert.match(fn, /LIMIT \* CHUNK_OVERFETCH/, '지식 검색이 배수를 적용하지 않는다');
  assert.match(fn, /\.slice\(0, LIMIT\)/, '병합한 문서를 상한까지 잘라야 한다');
  // 나머지 두 소스는 병합이 없으므로 배수를 쓰지 않는다 — 쓰면 프롬프트만 커진다.
  for (const name of ['searchQaMethods', 'searchQueries']) {
    const other = new RegExp(`export function ${name}[\\s\\S]*?\\n}`).exec(src)[0];
    assert.ok(!/CHUNK_OVERFETCH/.test(other), `${name}에는 배수가 필요 없다`);
  }
});
