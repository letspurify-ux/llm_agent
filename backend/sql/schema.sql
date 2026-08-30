-- 지식 관리 및 Q&A LLM Agent — agent 관리용 DB (MariaDB)
--
-- ⚠ 이 파일은 파괴적이다. 아래에서 6개 테이블을 전부 DROP한 뒤 다시 만든다.
--   운영 중인 DB에 실행하면 등록한 지식·쿼리와 chat_log가 전부 사라진다 (DDL은 롤백되지 않는다).
--   기존 설치에 변경분만 반영하려면 README의 마이그레이션 절을 볼 것.
--
-- 요구: MariaDB 11.7+ — vec_store의 VECTOR 타입과 VECTOR INDEX가 그 이상에서만 있다.
--   낮은 버전에서 돌리면 앞쪽 테이블은 만들어지고 vec_store에서 멈춘다(부분 적용).
--   그래서 vec_store를 파일 맨 뒤에 둔다 — 거기서 실패해도 나머지 스키마는 온전하다.
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

-- 대화 로그: 평가셋 구축과 "못 답한 질문" 발굴용.
-- 3일 지난 행은 서버가 기동 시 + 1시간 주기로 정리한다 (server.js).
CREATE TABLE chat_log (
  seq        INT AUTO_INCREMENT PRIMARY KEY,
  question   TEXT NOT NULL,        -- 서버가 2,000자로 제한한다 (server.js)
  answer     MEDIUMTEXT,           -- TEXT(65,535바이트)로는 부족하다: 20행×다컬럼 표에 셀당 200자면
                                   -- utf8mb4 한글 기준 100KB를 넘고, strict 모드에서 INSERT가 거부돼
                                   -- 하필 '결과가 큰 대화'만 로그에서 빠진다
  trace      JSON,                -- {v: 스키마 버전, search: 검색 적중 수(queries는 라우팅 동작 시에만, 아니면 null),
                                  --  steps: 실행 쿼리·바인드·결과. 실패는 steps[].error, 루프 가드 기록은 steps[].note,
                                  --  steps[].safe는 그 error 문구를 사용자 화면에 그대로 내보내도 되는지(우리가 쓴 안내문이면 true,
                                  --  드라이버·DB 원문이면 없음) — 화면에는 서버가 후자를 일반 문구로 바꿔 내보낸다}
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at)    -- 보존 기간 정리(DELETE)용
);

-- 벡터 검색용 임베딩 저장소.
-- 원본 3개 테이블(knowledge/qa_method/query_registry)은 변경하지 않고 companion 테이블로 둔다
-- (VECTOR INDEX는 NOT NULL 필수라, 임베딩이 아직 없는 원본 행과 공존하려면 분리가 단순하다).
-- embed-sync.js가 원본 텍스트의 MD5(embed_hash)를 비교해 신규/변경분만 임베딩한다.
--
-- 이 테이블만 MariaDB 11.7+를 요구하므로 파일 맨 뒤에 둔다 — 낮은 버전에서 여기서 멈춰도
-- 앞의 5개 테이블은 온전하고, 앱은 벡터 검색만 빼고(LIKE-only 폴백) 정상 동작한다.
CREATE TABLE vec_store (
  src        VARCHAR(20) NOT NULL,   -- 'knowledge' | 'qa_method' | 'query_registry'
  seq        INT NOT NULL,           -- 원본 행 seq
  embed_hash CHAR(32) NOT NULL,      -- MD5(임베딩한 텍스트) — 변경 감지용
  embedding  VECTOR(1024) NOT NULL,  -- bge-m3 1024차원 (모델을 바꿔도 1024차원 유지)
  PRIMARY KEY (src, seq),
  VECTOR INDEX (embedding) DISTANCE=cosine  -- 검색이 VEC_DISTANCE_COSINE을 쓰므로 반드시 cosine으로.
                                            -- 기본값(euclidean)이면 인덱스를 타지 못해 풀스캔이 된다
);

-- 앱 계정은 관리 테이블 4개는 SELECT만, 파생 테이블(vec_store, chat_log)에는 쓰기가 필요하다.
-- (테이블 단위 권한은 이름으로 저장되므로 이 파일을 다시 돌려도 살아남는다 — 재부여 불필요)
--   GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_store TO 'agent'@'localhost';
--   GRANT SELECT, INSERT, DELETE ON llm_agent.chat_log TO 'agent'@'localhost';
