-- 지식 관리 및 Q&A LLM Agent — agent 관리용 DB (MariaDB)
--
-- ⚠ 이 파일은 파괴적이다. 아래에서 6개 테이블을 전부 DROP한 뒤 다시 만든다.
--   운영 중인 DB에 실행하면 등록한 지식·쿼리와 chat_log가 전부 사라진다 (DDL은 롤백되지 않는다).
--   기존 설치에 변경분만 반영하려면 README의 마이그레이션 절을 볼 것.
--
-- 요구: MariaDB 11.7+ — vec_* 테이블의 VECTOR 타입과 VECTOR INDEX가 그 이상에서만 있다.
--   낮은 버전에서 돌리면 앞쪽 테이블은 만들어지고 vec_*에서 멈춘다(부분 적용).
--   그래서 vec_*를 파일 맨 뒤에 둔다 — 거기서 실패해도 나머지 스키마는 온전하다.
--
-- 적용: mariadb --default-character-set=utf8mb4 -u <user> -p < schema.sql

SET NAMES utf8mb4;

-- collation을 명시하는 이유: 서버 기본값이 버전에 따라 다르다(11.5+는 utf8mb4_uca1400_ai_ci,
-- 그 이전은 utf8mb4_general_ci). 그런데 agent.js는 query_name 조회가 대소문자를 무시한다는 전제로
-- nameKey()를 두고 있어, 배포 서버에 따라 조회와 루프 가드가 어긋날 수 있다. 전제를 고정한다.
CREATE DATABASE IF NOT EXISTS llm_agent DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
-- 이미 있는 DB에는 위 CREATE가 아무 일도 하지 않으므로 기본값을 따로 맞춰준다.
ALTER DATABASE llm_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE llm_agent;

DROP TABLE IF EXISTS chat_log;
DROP TABLE IF EXISTS vec_store;               -- 소스별로 나뉘기 전의 이름 (마이그레이션 참고)
DROP TABLE IF EXISTS vec_knowledge_chunk;
DROP TABLE IF EXISTS vec_qa_method;
DROP TABLE IF EXISTS vec_query_registry;
DROP TABLE IF EXISTS knowledge_chunk;         -- knowledge보다 먼저 — FK가 걸려 있다
DROP TABLE IF EXISTS knowledge;
DROP TABLE IF EXISTS qa_method;
DROP TABLE IF EXISTS query_registry;
DROP TABLE IF EXISTS target_db;

-- 지식 관리: 단순 지식 질문은 이 내용으로 답변한다
-- title에 UNIQUE를 두는 이유는 두 가지다.
--  ① 같은 제목의 지식이 두 벌 들어가면 각각 별도 seq로 임베딩되어 검색 결과에 나란히 올라오고,
--     프롬프트만 갉아먹으면서 어디에도 오류가 남지 않는다.
--  ② 시드 파일이 INSERT … ON DUPLICATE KEY UPDATE 하나로 멱등해진다 —
--     "지울 제목 목록"을 INSERT와 따로 손으로 맞추던 방식은 한쪽만 고치는 순간 조용히 어긋난다.
-- 인덱스에 이름을 주는 이유: 시드 파일이 `ADD UNIQUE KEY IF NOT EXISTS uk_title`로 같은 것을
-- 보장하는데, 이름이 다르면 같은 컬럼에 인덱스가 두 벌 생긴다.
CREATE TABLE knowledge (
  seq     INT AUTO_INCREMENT PRIMARY KEY,
  title   VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  UNIQUE KEY uk_title (title)
);

-- Q&A 처리 방법: 질문 유형별 처리 절차 서술.
-- 실행할 쿼리가 있으면 query_registry.query_name을 실행 순서대로 본문에 그대로 언급한다.
-- 지식 원문을 검색 단위로 나눈 파생 테이블. 원문(knowledge)은 손대지 않는다 — 청크는 언제든
-- 다시 만들 수 있어야 하고(doc_hash가 분할 규칙을 포함하므로 규칙을 고치면 자동으로 다시 나뉜다),
-- 되돌릴 수 없는 변환이 되면 규칙을 고치는 일이 벌이 된다.
--
-- 왜 나누는가: 임베딩은 행 하나에 벡터 하나이고 원문은 MAX_EMBED_TEXT_LEN(4,000자)에서 잘린다.
-- 2만 자짜리 지식을 등록하면 검색은 앞 20%만 보고 판단하고 뒤는 어떤 경로로도 모델에 닿지 않는데,
-- 오류가 한 줄도 남지 않는다. 나눠 두면 '문서의 앞 4,000자'가 아니라 '질문에 맞는 구간'이 실린다.
-- qa_method는 나누지 않는다 — 짧고, 경로A(agent.js selectQueries)가 본문 전체를 훑어 쿼리 이름을
-- 찾으므로 쪼개면 이름이 청크 경계에 걸려 라우팅이 조용히 끊긴다.
--
-- title/content라는 컬럼 이름은 knowledge와 같아야 한다 — 검색·프롬프트 조립이 컬럼 이름으로
-- 돌아가므로(search.js SEARCH_COLUMNS, llm-openai.js itemLine) 이름을 맞추면 그 코드가 안 바뀐다.
CREATE TABLE knowledge_chunk (
  seq      INT AUTO_INCREMENT PRIMARY KEY,  -- 프롬프트가 모델에게 보이는 식별자(k12의 12). 요청 내내 고정.
  doc_seq  INT NOT NULL,                    -- knowledge.seq
  chunk_no SMALLINT NOT NULL,               -- 문서 안 순번 (1부터)
  chunk_of SMALLINT NOT NULL,               -- 그 문서의 총 청크 수 — 제목의 (3~7/22) 표기에 쓴다
  doc_hash CHAR(32) NOT NULL,               -- MD5(분할 규칙 + 원문). 문서 단위 staleness를 이 테이블 안에서 판정한다
  title    VARCHAR(200) NOT NULL,           -- 문서 제목 복사 (knowledge.title)
  content  TEXT NOT NULL,                   -- 청크 본문
  UNIQUE KEY uk_doc_chunk (doc_seq, chunk_no),
  KEY k_doc (doc_seq),
  -- 문서가 지워지면 청크도 함께 지운다. 남으면 삭제된 지식이 검색에 계속 노출된다 —
  -- 벡터 쪽은 embed-sync의 고아 정리가 거두지만, 그것도 청크가 먼저 사라져야 동작한다.
  CONSTRAINT fk_chunk_doc FOREIGN KEY (doc_seq) REFERENCES knowledge(seq) ON DELETE CASCADE
);

CREATE TABLE qa_method (
  seq    INT AUTO_INCREMENT PRIMARY KEY,
  title  VARCHAR(200) NOT NULL,
  method TEXT NOT NULL,
  UNIQUE KEY uk_title (title)   -- knowledge.title과 같은 이유 (위 주석 참고)
);

-- 쿼리 관리: 조회용 DB에 실행할 수 있는 쿼리 목록. query_sql은 :param 바인드 변수 사용.
-- 보안: SELECT(또는 WITH) 조회 쿼리만 등록할 것 — 서버가 실행 직전 SELECT 전용 가드로 차단하지만,
--       조회 계정(target_db.db_user) 자체를 read-only 권한으로 두는 것을 권장한다.
CREATE TABLE query_registry (
  seq            INT AUTO_INCREMENT PRIMARY KEY,
  query_name     VARCHAR(100) NOT NULL UNIQUE,
  query_desc     TEXT,          -- 용도 요약: "어떤 질문일 때 무엇을 조회하는 쿼리인지".
                                -- 벡터 검색과 LLM의 쿼리 선택 근거이므로 성실히 작성할 것
  input_desc     TEXT,
  query_sql      TEXT NOT NULL,
  output_desc    TEXT,
  -- 조회대상 DB. ';'로 구분해 여러 개를 등록하면 LLM이 그중 하나를 골라 실행한다
  -- (예: 'STOCK_SEOUL;STOCK_BUSAN'). 하나만 적으면 지금까지와 같이 그 DB로 고정된다.
  -- 목록형으로 쓸 때는 query_desc에 '어느 질문일 때 어느 DB를 고르는가'를 함께 적을 것 —
  -- 모델에게 주어지는 것은 이 이름들과 설명뿐이고, 이름만으로는 무엇을 골라야 할지 알 수 없다.
  -- VARCHAR(500)인 이유: db_name이 VARCHAR(100)이라 100자짜리 후보 다섯 개까지는 들어간다.
  target_db_name VARCHAR(500) NOT NULL
);

-- 조회대상 DB 접속 정보.
-- db_password가 'ENV:변수명' 형식이면 서버 환경변수에서 읽는다.
-- 평문 저장은 개발용으로만 허용 — 운영에서는 반드시 ENV: 방식을 사용할 것.
CREATE TABLE target_db (
  seq             INT AUTO_INCREMENT PRIMARY KEY,
  db_name         VARCHAR(100) NOT NULL UNIQUE,
  db_type         VARCHAR(20)  NOT NULL DEFAULT 'oracle',
  connection_info VARCHAR(500) NOT NULL,
  db_user         VARCHAR(100),
  db_password     VARCHAR(200)
);

-- 대화 로그: 평가셋 구축과 "못 답한 질문" 발굴용.
-- 3일 지난 행은 서버가 기동 시 + 1시간 주기로 정리한다 (server.js).
CREATE TABLE chat_log (
  seq        INT AUTO_INCREMENT PRIMARY KEY,
  question   TEXT NOT NULL,        -- 서버가 2,000자로 제한한다 (server.js)
  answer     MEDIUMTEXT,           -- TEXT(65,535바이트)로는 부족하다: 20행×다컬럼 표에 셀당 200자면
                                   -- utf8mb4 한글 기준 100KB를 넘고, strict 모드에서 INSERT가 거부돼
                                   -- 하필 '결과가 큰 대화'만 로그에서 빠진다
  trace      JSON,                -- {v: 스키마 버전, outcome: 이 요청이 무엇으로 끝났는가(v3+에는 반드시 있다),
                                  --  search: 검색 요약 — v4부터 {searches: 검색 횟수, targets: 대상별 검색 횟수,
                                  --    knowledge/qaMethods/queries: 대상별 적중 수(찾아본 적 없거나 검색이 성립하지 않았으면 null,
                                  --    queries는 라우팅 동작 시에만), queriesFailed/searchFailed: 목록·검색이 성립하지 않았음},
                                  --  timing: v4부터 {total, llm[], search[], oracle[]} — 구간별 소요 ms (어디가 느린지의 유일한 기록),
                                  --  steps: 실행 검색·쿼리. v4부터 검색 기록 {search, targets, hits, failed?}이 쿼리 기록과 같은 배열에
                                  --    순서대로 섞인다 (번호가 곧 프롬프트의 스텝 번호). 실패는 steps[].error, 루프 가드 기록은 steps[].note,
                                  --  steps[].safe는 그 error 문구를 사용자 화면에 그대로 내보내도 되는지(우리가 쓴 안내문이면 true,
                                  --  드라이버·DB 원문이면 없음) — 화면에는 서버가 후자를 일반 문구로 바꿔 내보낸다.
                                  --  steps[].hint는 모델에게만 준 복구 지침(있을 때만) — 화면에는 나가지 않는다}
                                  -- outcome = 'answered' | 'error'(서버 오류, trace.error에 원문) |
                                  --           'rejected'(입력 거부, trace.reason에 사유: no_message/empty_message/
                                  --                      too_long/body_too_large/bad_body)
                                  -- 답하지 못한 요청도 반드시 한 행을 남긴다 — 그 행이 이 테이블의 존재 이유다 (server.js).
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at)    -- 보존 기간 정리(DELETE)용
);

-- 벡터 검색용 임베딩 저장소.
-- 원본 테이블(knowledge_chunk/qa_method/query_registry)은 변경하지 않고 companion 테이블로 둔다
-- (VECTOR INDEX는 NOT NULL 필수라, 임베딩이 아직 없는 원본 행과 공존하려면 분리가 단순하다).
-- embed-sync.js가 원본 텍스트의 MD5(embed_hash, DB에서 계산)를 비교해 신규/변경분만 임베딩한다.
--
-- 소스마다 테이블을 따로 둔다. 한 테이블에 담고 `WHERE src = ?`로 거르던 구조에서는 ANN이 상위
-- K건을 고른 '뒤' src로 걸러지므로, 큰 소스가 K건을 차지해 작은 소스의 검색이 조용히 0~2건으로
-- 주저앉았다 — 지식을 청크로 나누면 그 비대칭이 열 배로 벌어져 qa_method 검색이 상한을 못 채운다.
-- 인덱스를 나누면 각자 자기 인덱스에서 LIMIT건만 찾으면 되므로 그 부류의 실패가 구조적으로
-- 사라지고, 훑을 양이 줄어 mhnsw_ef_search도 낮출 수 있다 (search.js EF_SEARCH).
-- 테이블 이름은 `vec_<원본테이블>` 규칙이다 — search.js·embed-sync.js가 그 규칙으로 이름을 만든다.
--
-- 이 테이블들만 MariaDB 11.7+를 요구하므로 파일 맨 뒤에 둔다 — 낮은 버전에서 여기서 멈춰도
-- 앞의 테이블들은 온전하고 서버는 뜬다. 다만 검색이 벡터 단일 경로라(backend/src/search.js)
-- 이 테이블이 없으면 지식·처리방법·쿼리를 하나도 찾지 못하고 '검색 불가'로 기록된다.
CREATE TABLE vec_knowledge_chunk (
  seq        INT NOT NULL PRIMARY KEY,   -- knowledge_chunk.seq
  embed_hash CHAR(32) NOT NULL,          -- 변경 감지용 MD5(모델명+원문) — MariaDB가 계산한다 (embed-sync.js hashExpr)
  embedding  VECTOR(1024) NOT NULL,      -- bge-m3 1024차원 (모델을 바꿔도 1024차원 유지)
  VECTOR INDEX (embedding) DISTANCE=cosine  -- 검색이 VEC_DISTANCE_COSINE을 쓰므로 반드시 cosine으로.
                                            -- 기본값(euclidean)이면 인덱스를 타지 못해 풀스캔이 된다
);

CREATE TABLE vec_qa_method (
  seq        INT NOT NULL PRIMARY KEY,
  embed_hash CHAR(32) NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  VECTOR INDEX (embedding) DISTANCE=cosine
);

CREATE TABLE vec_query_registry (
  seq        INT NOT NULL PRIMARY KEY,
  embed_hash CHAR(32) NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  VECTOR INDEX (embedding) DISTANCE=cosine
);

-- 앱 계정은 관리 테이블 4개는 SELECT만, 파생 테이블(knowledge_chunk, vec_*, chat_log)에는 쓰기가 필요하다.
-- (테이블 단위 권한은 이름으로 저장되므로 이 파일을 다시 돌려도 살아남는다 — 재부여 불필요)
--   GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.knowledge_chunk TO 'agent'@'localhost';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_knowledge_chunk TO 'agent'@'localhost';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_qa_method TO 'agent'@'localhost';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_query_registry TO 'agent'@'localhost';
--   GRANT SELECT, INSERT, DELETE ON llm_agent.chat_log TO 'agent'@'localhost';
