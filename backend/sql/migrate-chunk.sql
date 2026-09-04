-- 기존 설치를 청크 구조로 옮긴다. 신규 설치는 schema.sql 하나면 되고 이 파일은 필요 없다.
-- 멱등하게 썼다 — 도중에 끊겨도 다시 돌리면 된다.
--
--   mariadb -u root -p llm_agent < backend/sql/migrate-chunk.sql
--   cd backend && npm run embed     # 청크 생성 + 최초 임베딩 (아래 ④ 참고)
--
-- 순서가 중요하다: ①②는 임베딩을 다시 계산하지 않고, ③④만 새 임베딩을 만든다.

USE llm_agent;

-- ───────────────────────────────────────────────────────────────────────
-- ① 벡터 저장소를 소스별로 나눈다 (재임베딩 없음 — 기존 벡터를 그대로 옮긴다)
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vec_qa_method (
  seq        INT NOT NULL PRIMARY KEY,
  embed_hash CHAR(32) NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  VECTOR INDEX (embedding) DISTANCE=cosine
);

CREATE TABLE IF NOT EXISTS vec_query_registry (
  seq        INT NOT NULL PRIMARY KEY,
  embed_hash CHAR(32) NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  VECTOR INDEX (embedding) DISTANCE=cosine
);

CREATE TABLE IF NOT EXISTS vec_knowledge_chunk (
  seq        INT NOT NULL PRIMARY KEY,
  embed_hash CHAR(32) NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  VECTOR INDEX (embedding) DISTANCE=cosine
);

-- vec_store가 아직 있으면 옮긴다. knowledge 벡터는 옮기지 않는다 —
-- 청크 단위로 다시 만들어야 하므로(④) 문서 단위 벡터는 쓸 곳이 없다.
INSERT IGNORE INTO vec_qa_method (seq, embed_hash, embedding)
  SELECT seq, embed_hash, embedding FROM vec_store WHERE src = 'qa_method';
INSERT IGNORE INTO vec_query_registry (seq, embed_hash, embedding)
  SELECT seq, embed_hash, embedding FROM vec_store WHERE src = 'query_registry';

-- ───────────────────────────────────────────────────────────────────────
-- ② 청크 테이블 (비어 있는 채로 만든다 — 채우는 것은 embed-sync의 일이다)
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_chunk (
  seq      INT AUTO_INCREMENT PRIMARY KEY,
  doc_seq  INT NOT NULL,
  chunk_no SMALLINT NOT NULL,
  chunk_of SMALLINT NOT NULL,
  doc_hash CHAR(32) NOT NULL,
  title    VARCHAR(200) NOT NULL,
  content  TEXT NOT NULL,
  UNIQUE KEY uk_doc_chunk (doc_seq, chunk_no),
  KEY k_doc (doc_seq),
  CONSTRAINT fk_chunk_doc FOREIGN KEY (doc_seq) REFERENCES knowledge(seq) ON DELETE CASCADE
);

-- ───────────────────────────────────────────────────────────────────────
-- ③ 권한 (앱 계정 이름이 다르면 바꿔 쓴다)
-- ───────────────────────────────────────────────────────────────────────
-- GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.knowledge_chunk       TO 'agent'@'localhost';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_knowledge_chunk   TO 'agent'@'localhost';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_qa_method         TO 'agent'@'localhost';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_query_registry    TO 'agent'@'localhost';
-- FLUSH PRIVILEGES;

-- ───────────────────────────────────────────────────────────────────────
-- ④ 청크 생성 + 최초 임베딩은 SQL이 아니라 embed-sync가 한다:
--
--      cd backend && npm run embed
--
--    지식 문서 수 × 평균 청크 수만큼 임베딩 호출이 한 번 필요하다 (문서 1,000건 × 10청크면 1만 회).
--    배치로 돌지만 시간이 걸리므로 한산한 시간에 미리 돌리는 편이 낫다. 서버 기동 시에도 같은
--    동기화가 돌지만, 그때는 첫 질문이 그 시간을 그대로 기다린다.
--
-- ⑤ 위가 끝나고 검색이 정상인 것을 확인한 뒤에 옛 테이블을 지운다:
--
--      DROP TABLE vec_store;
--
--    먼저 지우지 않는 이유: ①이 옮긴 것이 맞는지 확인하기 전에는 되돌릴 길을 남겨 둔다.
-- ───────────────────────────────────────────────────────────────────────
