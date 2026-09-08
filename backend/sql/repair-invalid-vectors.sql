-- 이전 버전에서 성공으로 저장된 영벡터와 FP32 제곱합의 안전 범위를 벗어난 벡터를 거둔다.
-- 운영 스키마에 연결해 한 번 실행한 뒤 npm run embed로 누락분을 다시 계산한다.
-- 정상 벡터와 원본은 보존한다. 반복 실행해도 같은 결과이며 DB 이름을 고정하지 않는다.
-- 매 동기화마다 전체 벡터를 읽는 비용을 피하기 위해 일회성 복구로 분리한다.
-- 같은 벡터끼리 코사인 거리를 재면 MariaDB는 영벡터도 0으로 반환한다.
-- 영벡터까지의 유클리드 거리(노름)로 판정한다. 스키마와 같은 1024차원이다.
-- 극소 벡터는 노름이 0이 아니어도 코사인 계산에서 제곱합이 무너진다.
-- 범위는 sqrt(FP32 최소 정규수) ~ sqrt(FP32 최댓값)이며 정상 단위 벡터(노름 1)는 보존한다.
SET @repair_zero_vector = VEC_FromText(CONCAT('[', REPEAT('0,', 1023), '0]'));
DELETE FROM vec_knowledge_chunk WHERE COALESCE(VEC_DISTANCE_EUCLIDEAN(embedding, @repair_zero_vector), 0) NOT BETWEEN 1.0842021724855044e-19 AND 1.844674352395373e19;
DELETE FROM vec_qa_method WHERE COALESCE(VEC_DISTANCE_EUCLIDEAN(embedding, @repair_zero_vector), 0) NOT BETWEEN 1.0842021724855044e-19 AND 1.844674352395373e19;
DELETE FROM vec_query_registry WHERE COALESCE(VEC_DISTANCE_EUCLIDEAN(embedding, @repair_zero_vector), 0) NOT BETWEEN 1.0842021724855044e-19 AND 1.844674352395373e19;
SET @repair_zero_vector = NULL;
