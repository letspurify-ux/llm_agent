-- 기존 설치에서 지식 본문을 TEXT(최대 65,535바이트)에서 LONGTEXT로 확장한다.
-- schema.sql은 기존 데이터를 삭제하므로 운영 DB에는 이 파일만 적용한다.

-- 적용: mariadb --default-character-set=utf8mb4 -u <관리자> -p <DB 이름> < migrate-knowledge-content.sql (DB는 명령줄로만 정한다)

ALTER TABLE knowledge
  MODIFY COLUMN content LONGTEXT NOT NULL;
