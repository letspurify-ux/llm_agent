-- 데모 시나리오 샘플 데이터
--  1) "배치 재시작 방법 알려줘"        → 지식만으로 답변 (쿼리 0회)
--  2) "BATCH001 작업 상태 알려줘"      → batch_job_status 1회 실행 후 답변
--  3) "홍길동 고객 주문 상태 알려줘"    → find_customer_id → order_status_by_customer 2단계 실행 후 답변

SET NAMES utf8mb4;
USE llm_agent;

INSERT INTO knowledge (title, content) VALUES
('배치 재시작 방법', '배치 작업이 FAILED 상태이면 배치 서버(batch01)에 접속 후 restart_batch.sh <JOB_ID> 를 실행하여 재시작한다. 실행 전 반드시 로그를 백업한다.'),
('시스템 점검 일정', '매월 첫째 주 일요일 02:00~04:00 정기 점검. 점검 중 조회 서비스는 중단된다.');

INSERT INTO qa_method (title, method) VALUES
('배치 작업 상태 확인', '배치 작업 상태 질문이면 batch_job_status 쿼리를 실행한다. :job_id 는 질문에서 추출한다(예: BATCH001). STATUS가 FAILED면 배치 재시작 방법 지식을 함께 안내한다.'),
('고객 주문 상태 확인', '1단계: find_customer_id 쿼리로 고객명(:customer_name)으로 CUSTOMER_ID를 조회한다. 2단계: 조회된 CUSTOMER_ID로 order_status_by_customer 쿼리를 실행하여 최근 주문 상태로 답변한다.');

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
 '최근 주문 5건의 상태와 금액', 'ORDER_DB');

-- qa_method 없이 단독 등록된 쿼리 — query_desc만으로 검색·선택되는 경로B 데모
INSERT INTO query_registry (query_name, query_desc, input_desc, query_sql, output_desc, target_db_name) VALUES
('batch_list_by_status', '특정 상태(FAILED/SUCCESS/RUNNING)인 배치 작업 전체 목록을 조회한다. "실패한 배치 다 보여줘", "지금 돌고 있는 배치 있어?" 같은 질문에 사용',
 ':status = 배치 상태 코드 (실패=FAILED, 성공=SUCCESS, 진행중=RUNNING)',
 'SELECT JOB_ID, JOB_NAME, TO_CHAR(LAST_RUN_AT, ''YYYY-MM-DD HH24:MI'') AS LAST_RUN_AT FROM BATCH_JOBS WHERE STATUS = :status ORDER BY LAST_RUN_AT DESC',
 '해당 상태인 배치 작업 목록', 'ORDER_DB');

-- 로컬 Oracle 테스트 컨테이너(space-voc-oracle) 기준. 조회 계정은 SELECT 권한만 가진 VOC_READER.
INSERT INTO target_db (db_name, db_type, connection_info, db_user, db_password) VALUES
('ORDER_DB', 'oracle', 'localhost:1521/FREEPDB1', 'voc_reader', 'ENV:ORDER_DB_PASSWORD');
