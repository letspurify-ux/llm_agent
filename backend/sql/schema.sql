-- 지식 관리 및 Q&A LLM Agent — agent 관리용 DB (MariaDB)
-- 적용: mariadb -u <user> -p < schema.sql

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS llm_agent DEFAULT CHARACTER SET utf8mb4;
USE llm_agent;

DROP TABLE IF EXISTS knowledge;
DROP TABLE IF EXISTS qa_method;
DROP TABLE IF EXISTS query_registry;
DROP TABLE IF EXISTS target_db;

-- 지식 관리: 단순 지식 질문은 이 내용으로 답변한다
CREATE TABLE knowledge (
  seq     INT AUTO_INCREMENT PRIMARY KEY,
  title   VARCHAR(200) NOT NULL,
  content TEXT NOT NULL
);

-- Q&A 처리 방법: 질문 유형별 처리 절차 서술.
-- 실행할 쿼리가 있으면 query_registry.query_name을 실행 순서대로 본문에 그대로 언급한다.
CREATE TABLE qa_method (
  seq    INT AUTO_INCREMENT PRIMARY KEY,
  title  VARCHAR(200) NOT NULL,
  method TEXT NOT NULL
);

-- 쿼리 관리: 조회용 DB에 실행할 수 있는 쿼리 목록. query_sql은 :param 바인드 변수 사용.
-- 보안: SELECT(또는 WITH) 조회 쿼리만 등록할 것 — 서버가 실행 직전 SELECT 전용 가드로 차단하지만,
--       조회 계정(target_db.db_user) 자체를 read-only 권한으로 두는 것을 권장한다.
CREATE TABLE query_registry (
  seq            INT AUTO_INCREMENT PRIMARY KEY,
  query_name     VARCHAR(100) NOT NULL UNIQUE,
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
