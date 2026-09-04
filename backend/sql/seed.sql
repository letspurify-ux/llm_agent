-- 데모 시나리오 샘플 데이터
--  1) "배치 재시작 방법 알려줘"        → 지식만으로 답변 (쿼리 0회)
--  2) "BATCH001 작업 상태 알려줘"      → batch_job_status 1회 실행 후 답변
--  3) "홍길동 고객 주문 상태 알려줘"    → find_customer_id → order_status_by_customer 2단계 실행 후 답변

SET NAMES utf8mb4;
USE llm_agent;

-- 재실행 가능(멱등): 자연키(title / query_name / db_name)의 UNIQUE에 얹어 덮어쓴다.
-- 조건 없는 DELETE로 비우지 않는 이유는 seed-space.sql이 넣은 SPACE 지식까지 지우기 때문이고,
-- "지울 이름 목록"을 따로 두지 않는 이유는 그 목록이 아래 INSERT와 손으로 맞춰야 하는 사본이라
-- 한쪽만 고치는 순간 옛 행이 남거나(UNIQUE 없는 테이블) 시드가 중간에 죽기(UNIQUE 있는 테이블) 때문이다.
-- ON DUPLICATE KEY UPDATE는 그 사본 자체를 없앤다.
--
-- 단, 그 방식은 자연키에 UNIQUE가 있어야 성립한다. 없으면 ON DUPLICATE KEY가 발동하지 않고
-- 재실행마다 같은 행이 그대로 쌓인다 — 조용히, 오류 하나 없이. (구 스키마에서 실측: 3회 실행에
-- knowledge 7건 → 21건.) README 마이그레이션을 건너뛴 설치에서 그 일이 벌어지므로 여기서 보장한다.
-- 이미 중복이 있으면 이 ALTER가 실패하는데, 그게 조용한 중복보다 낫다.
ALTER TABLE knowledge  ADD UNIQUE KEY IF NOT EXISTS uk_title (title);
ALTER TABLE qa_method ADD UNIQUE KEY IF NOT EXISTS uk_title (title);

-- 이 파일은 knowledge_chunk를 건드리지 않는다. 청크는 원문에서 파생되므로 embed-sync가 만든다 —
-- ON DUPLICATE KEY UPDATE로 본문이 바뀌면 문서 해시가 달라져 다음 동기화가 그 문서만 재분할한다.
-- 여기서 손으로 넣으면 두 곳이 같은 것을 만들게 되고, 어긋나도 '검색 결과가 이상하다'로만 보인다.

-- target_db_name은 ';'로 구분한 목록을 담을 수 있다(여러 DB 중 하나를 LLM이 고른다).
-- 구 스키마의 VARCHAR(100)에 목록을 넣으면 MariaDB 기본 모드에서 뒤가 잘린 채 저장되고,
-- 잘려 나간 후보는 '등록한 적 없는 DB'가 되어 프롬프트에도 실행에도 나타나지 않는다 —
-- 오류 없이 후보만 사라지므로 여기서 폭을 보장한다. 이미 넓으면 아무 일도 하지 않는다.
ALTER TABLE query_registry MODIFY COLUMN target_db_name VARCHAR(500) NOT NULL;

INSERT INTO knowledge (title, content) VALUES
('배치 재시작 방법', '배치 작업이 FAILED 상태이면 배치 서버(batch01)에 접속 후 restart_batch.sh <JOB_ID> 를 실행하여 재시작한다. 실행 전 반드시 로그를 백업한다.'),
('시스템 점검 일정', '매월 첫째 주 일요일 02:00~04:00 정기 점검. 점검 중 조회 서비스는 중단된다.')
ON DUPLICATE KEY UPDATE content = VALUES(content);

INSERT INTO qa_method (title, method) VALUES
('배치 작업 상태 확인', '배치 작업 상태 질문이면 batch_job_status 쿼리를 실행한다. :job_id 는 질문에서 추출한다(예: BATCH001). STATUS가 FAILED면 배치 재시작 방법 지식을 함께 안내한다.'),
('고객 주문 상태 확인', '1단계: find_customer_id 쿼리로 고객명(:customer_name)으로 CUSTOMER_ID를 조회한다. 2단계: 조회된 CUSTOMER_ID로 order_status_by_customer 쿼리를 실행하여 최근 주문 상태로 답변한다.')
ON DUPLICATE KEY UPDATE method = VALUES(method);

INSERT INTO query_registry (query_name, query_desc, input_desc, query_sql, output_desc, target_db_name) VALUES
('batch_job_status', '특정 배치 작업의 현재 실행 상태(성공/실패/실행중)와 마지막 실행 시각을 조회한다. 배치 작업 상태, 배치 실패 여부, 배치 돌았는지 등의 질문에 사용',
 ':job_id = 배치 작업 ID (예: BATCH001)',
 'SELECT JOB_ID, JOB_NAME, STATUS, TO_CHAR(LAST_RUN_AT, ''YYYY-MM-DD HH24:MI'') AS LAST_RUN_AT FROM BATCH_JOBS WHERE JOB_ID = :job_id',
 'STATUS: RUNNING/SUCCESS/FAILED', 'ORDER_DB'),
('find_customer_id', '고객 이름으로 고객 ID와 등급을 조회한다. 고객 관련 질문에서 고객명을 CUSTOMER_ID로 변환하는 첫 단계로 사용',
 ':customer_name = 고객명 (한글)',
 'SELECT CUSTOMER_ID, CUSTOMER_NAME, GRADE FROM CUSTOMERS WHERE CUSTOMER_NAME = :customer_name',
 'CUSTOMER_ID 반환. 다음 단계 쿼리의 입력으로 사용', 'ORDER_DB'),
('order_status_by_customer', '고객 ID로 최근 주문 목록(주문번호/상태/일자/금액)을 조회한다. 주문 상태, 배송 상태, 주문 내역 질문에 사용',
 ':customer_id = find_customer_id 결과의 CUSTOMER_ID',
 'SELECT ORDER_ID, STATUS, TO_CHAR(ORDER_DATE, ''YYYY-MM-DD'') AS ORDER_DATE, AMOUNT FROM ORDERS WHERE CUSTOMER_ID = :customer_id ORDER BY ORDER_DATE DESC FETCH FIRST 5 ROWS ONLY',
 '최근 주문 5건의 상태와 금액', 'ORDER_DB')
ON DUPLICATE KEY UPDATE query_desc = VALUES(query_desc), input_desc = VALUES(input_desc),
  query_sql = VALUES(query_sql), output_desc = VALUES(output_desc), target_db_name = VALUES(target_db_name);

-- qa_method 없이 단독 등록된 쿼리 — query_desc만으로 검색·선택되는 경로B 데모.
-- 주의: 이 경로는 LLM_PROVIDER=openai에서만 시연된다. Mock은 매칭된 qa_method 본문에 이름이
-- 적힌 쿼리만 후보로 삼으므로(llm.js plannedQueries) 이 쿼리를 절대 고르지 않는다 — 오류 없이
-- 지식만으로 답이 나간다. 아래 today_date도 같다 (README 데모 시나리오 표의 주 참고).
INSERT INTO query_registry (query_name, query_desc, input_desc, query_sql, output_desc, target_db_name) VALUES
('batch_list_by_status', '특정 상태(FAILED/SUCCESS/RUNNING)인 배치 작업 전체 목록을 조회한다. "실패한 배치 다 보여줘", "지금 돌고 있는 배치 있어?" 같은 질문에 사용',
 ':status = 배치 상태 코드 (실패=FAILED, 성공=SUCCESS, 진행중=RUNNING)',
 'SELECT JOB_ID, JOB_NAME, TO_CHAR(LAST_RUN_AT, ''YYYY-MM-DD HH24:MI'') AS LAST_RUN_AT FROM BATCH_JOBS WHERE STATUS = :status ORDER BY LAST_RUN_AT DESC',
 '해당 상태인 배치 작업 목록', 'ORDER_DB')
ON DUPLICATE KEY UPDATE query_desc = VALUES(query_desc), input_desc = VALUES(input_desc),
  query_sql = VALUES(query_sql), output_desc = VALUES(output_desc), target_db_name = VALUES(target_db_name);

-- 바인드 변수가 없는 쿼리 — DB 서버의 현재 시각을 직접 확인하는 용도(바인드 없는 쿼리의 데모이기도 하다).
-- 오늘 날짜·현재 시각(KST, 요일 포함)은 서버가 매 프롬프트 끝에 '현재 시각'으로 싣는다
-- (llm-openai.js buildPrompt). 그래서 "오늘 며칠이야"와 상대 날짜("어제", "이번 달")의 기준일은
-- 조회 없이 그 값으로 답하고, 이 쿼리는 DB 서버 시각 자체를 물을 때(프롬프트 시각과의 어긋남 점검 등)만 쓴다.
-- 아래 query_desc가 그 순위를 모델에게 말한다 — "먼저 실행하라"고 적혀 있으면 모델은 매 질문마다
-- LLM 왕복과 DB 조회를 한 번씩 더 쓴다.
-- SYSDATE가 아니라 SYSTIMESTAMP AT TIME ZONE 'Asia/Seoul'을 쓰는 이유:
--   SYSDATE는 DB 서버 로컬 시각이고, 로컬 Oracle 테스트 컨테이너는 UTC로 돈다(실측).
--   그러면 KST 00:00~09:00 사이에는 매일 '어제' 날짜가 오늘로 답변된다 — 오류 없이, 조용히.
--   기준일을 얻자고 만든 쿼리가 기준일을 틀리면 상대 날짜 계산이 통째로 하루씩 밀린다.
--   운영 DB가 KST로 돌더라도 이 식은 같은 값을 주므로, 타임존을 명시하는 쪽이 항상 안전하다.
-- DUAL은 PUBLIC 시노님이라 VOC_READER에 별도 GRANT가 필요 없다 (oracle-init.sql 수정 불필요).
INSERT INTO query_registry (query_name, query_desc, input_desc, query_sql, output_desc, target_db_name) VALUES
('today_date', 'DB 서버의 현재 날짜와 시각(한국 시간)을 조회한다. 오늘 날짜·현재 시각·상대 날짜의 기준일은 프롬프트의 현재 시각으로 이미 알고 있으므로 조회하지 말고, DB 서버 시각 자체를 확인해야 할 때만 실행한다',
 '없음 — 바인드 변수를 받지 않는다 (params는 빈 객체로 둘 것)',
 'SELECT TO_CHAR(SYSTIMESTAMP AT TIME ZONE ''Asia/Seoul'', ''YYYY-MM-DD'') AS TODAY, TO_CHAR(SYSTIMESTAMP AT TIME ZONE ''Asia/Seoul'', ''HH24:MI:SS'') AS NOW_TIME FROM DUAL',
 'TODAY: 오늘 날짜(YYYY-MM-DD), NOW_TIME: 현재 시각(HH24:MI:SS). 둘 다 KST 기준이며 항상 1건', 'ORDER_DB')
ON DUPLICATE KEY UPDATE query_desc = VALUES(query_desc), input_desc = VALUES(input_desc),
  query_sql = VALUES(query_sql), output_desc = VALUES(output_desc), target_db_name = VALUES(target_db_name);

-- 로컬 Oracle 테스트 컨테이너 기준 (oracle-init.sql로 초기화). 조회 계정은 SELECT 권한만 가진 VOC_READER.
INSERT INTO target_db (db_name, db_type, connection_info, db_user, db_password) VALUES
('ORDER_DB', 'oracle', 'localhost:1521/FREEPDB1', 'voc_reader', 'ENV:ORDER_DB_PASSWORD')
ON DUPLICATE KEY UPDATE db_type = VALUES(db_type), connection_info = VALUES(connection_info),
  db_user = VALUES(db_user), db_password = VALUES(db_password);
