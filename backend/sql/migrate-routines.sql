-- 기존 데이터는 유지하고 모든 기존 실행 항목을 QUERY로 분류한다.
-- 애플리케이션 업데이트 전에 관리 DB에 적용한다. 재실행 가능.
-- 적용: mariadb --default-character-set=utf8mb4 -u <관리자> -p <DB 이름> < migrate-routines.sql (DB는 명령줄로만 정한다)
ALTER TABLE query_registry
  ADD COLUMN IF NOT EXISTS query_type VARCHAR(20) NOT NULL DEFAULT 'QUERY'
    CHECK (query_type IN ('QUERY', 'PROCEDURE', 'FUNCTION')) AFTER query_name,
  ADD COLUMN IF NOT EXISTS bind_config TEXT NULL AFTER query_type;
