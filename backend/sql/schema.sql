-- 지식 관리 및 Q&A LLM Agent — agent 관리용 DB (MariaDB)
-- 적용: mariadb -u <user> -p < schema.sql

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS llm_agent DEFAULT CHARACTER SET utf8mb4;
USE llm_agent;

DROP TABLE IF EXISTS chat_log;
DROP TABLE IF EXISTS vec_store;
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
CREATE TABLE knowledge (
  seq     INT AUTO_INCREMENT PRIMARY KEY,
  title   VARCHAR(200) NOT NULL UNIQUE,
  content TEXT NOT NULL
);

-- Q&A 처리 방법: 질문 유형별 처리 절차 서술.
-- 실행할 쿼리가 있으면 query_registry.query_name을 실행 순서대로 본문에 그대로 언급한다.
CREATE TABLE qa_method (
  seq    INT AUTO_INCREMENT PRIMARY KEY,
  title  VARCHAR(200) NOT NULL UNIQUE,  -- knowledge.title과 같은 이유 (위 주석 참고)
  method TEXT NOT NULL
);

-- 쿼리 관리: 조회용 DB에 실행할 수 있는 쿼리 목록. query_sql은 :param 바인드 변수 사용.
-- 보안: SELECT(또는 WITH) 조회 쿼리만 등록할 것 — 서버가 실행 직전 SELECT 전용 가드로 차단하지만,
--       조회 계정(target_db.db_user) 자체를 read-only 권한으로 두는 것을 권장한다.
CREATE TABLE query_registry (
  seq            INT AUTO_INCREMENT PRIMARY KEY,
  query_name     VARCHAR(100) NOT NULL UNIQUE,
  query_desc     TEXT,          -- 용도 요약: "어떤 질문일 때 무엇을 조회하는 쿼리인지".
                                -- 벡터/LIKE 검색과 LLM의 쿼리 선택 근거이므로 성실히 작성할 것
  input_desc     TEXT,
  query_sql      TEXT NOT NULL,
  output_desc    TEXT,
  target_db_name VARCHAR(100) NOT NULL
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

-- 벡터 검색용 임베딩 저장소.
-- 원본 3개 테이블(knowledge/qa_method/query_registry)은 변경하지 않고 companion 테이블로 둔다
-- (VECTOR INDEX는 NOT NULL 필수라, 임베딩이 아직 없는 원본 행과 공존하려면 분리가 단순하다).
-- embed-sync.js가 원본 텍스트의 MD5(embed_hash)를 비교해 신규/변경분만 임베딩한다.
CREATE TABLE vec_store (
  src        VARCHAR(20) NOT NULL,   -- 'knowledge' | 'qa_method' | 'query_registry'
  seq        INT NOT NULL,           -- 원본 행 seq
  embed_hash CHAR(32) NOT NULL,      -- MD5(임베딩한 텍스트) — 변경 감지용
  embedding  VECTOR(1024) NOT NULL,  -- bge-m3 1024차원 (모델을 바꿔도 1024차원 유지)
  PRIMARY KEY (src, seq),
  VECTOR INDEX (embedding) DISTANCE=cosine  -- 검색이 VEC_DISTANCE_COSINE을 쓰므로 반드시 cosine으로.
                                            -- 기본값(euclidean)이면 인덱스를 타지 못해 풀스캔이 된다
);
-- 앱 계정은 관리 테이블 4개는 SELECT만, 파생 테이블(vec_store, chat_log)에는 쓰기가 필요하다:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_store TO 'agent'@'localhost';
--   GRANT SELECT, INSERT, DELETE ON llm_agent.chat_log TO 'agent'@'localhost';

-- 대화 로그: 평가셋 구축과 "못 답한 질문" 발굴용.
-- 3일 지난 행은 서버가 기동 시 + 1시간 주기로 정리한다 (server.js).
CREATE TABLE chat_log (
  seq        INT AUTO_INCREMENT PRIMARY KEY,
  question   TEXT NOT NULL,        -- 서버가 2,000자로 제한한다 (server.js)
  answer     MEDIUMTEXT,           -- TEXT(65,535바이트)로는 부족하다: 20행×다컬럼 표에 셀당 200자면
                                   -- utf8mb4 한글 기준 100KB를 넘고, strict 모드에서 INSERT가 거부돼
                                   -- 하필 '결과가 큰 대화'만 로그에서 빠진다
  trace      JSON,                -- {v: 스키마 버전, search: 검색 적중 수(queries는 라우팅 동작 시에만, 아니면 null),
                                  --  steps: 실행 쿼리·바인드·결과. 실패는 steps[].error, 루프 가드 기록은 steps[].note}
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at)    -- 보존 기간 정리(DELETE)용
);
