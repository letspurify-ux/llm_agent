import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionSpec, inputBindNames } from '../src/execution.js';
import { validateAdminRecord } from '../src/admin.js';
import { buildPrompt } from '../src/llm-openai.js';

const routine = (over = {}) => ({ query_name: 'orders_proc', query_type: 'PROCEDURE',
  query_sql: 'BEGIN app.orders(p_id => :id, p_rows => :result); END;',
  bind_config: JSON.stringify({ id: { dir: 'IN', type: 'STRING' }, result: { dir: 'OUT', type: 'CURSOR' } }),
  query_desc: '주문 조회', input_desc: 'id 고객 ID', output_desc: '주문 목록', target_db_name: 'OPS', ...over });

test('기존 쿼리는 QUERY 기본값이며 루틴의 입력은 IN/INOUT만 노출한다', () => {
  assert.deepEqual(executionSpec({ query_sql: 'SELECT :id FROM dual;' }).inputs, ['id']);
  assert.equal(executionSpec(routine()).type, 'PROCEDURE');
  assert.deepEqual(inputBindNames(routine()), ['id']);
  const row = routine({ query_type: 'FUNCTION', query_sql: 'BEGIN :result := app.total(:ID); END;',
    bind_config: '{"id":{"dir":"INOUT","type":"NUMBER"},"result":{"dir":"OUT","type":"NUMBER"}}' });
  assert.deepEqual(inputBindNames(row), ['ID']);
  assert.equal(executionSpec(row).bindings.length, 2);
  assert.equal(validateAdminRecord('queries', routine()).query_type, 'PROCEDURE');
  const query = { ...routine(), query_sql: 'SELECT :id FROM dual', bind_config: '' };
  delete query.query_type;
  assert.equal(validateAdminRecord('queries', query).query_type, 'QUERY');
});

test('루틴은 단일 호출만 허용하며 다른 SQL/블록과 유형 불일치를 거부한다', () => {
  for (const query_sql of [
    'BEGIN app.orders(:id, :result); DELETE FROM orders; END;',
    'BEGIN EXECUTE IMMEDIATE :id; END;',
    'DECLARE n NUMBER; BEGIN app.orders(:id,:result); END;',
    'BEGIN app.orders(:id, :result); COMMIT; END;',
    'BEGIN app.orders(:id, :result); END; /',
    "BEGIN app.orders('literal', :result); END;",
    'BEGIN app.orders(:1, :result); END;',
    'BEGIN app.orders(:id, :result); END; --comment',
    'BEGIN :result := app.orders(:id); END;',
    'SELECT :id FROM dual',
  ]) assert.throws(() => executionSpec(routine({ query_sql })), { safe: true });
  assert.throws(() => executionSpec(routine({ query_type: 'FUNCTION' })));
  assert.throws(() => executionSpec(routine({ query_type: 'unknown' })));
  assert.throws(() => executionSpec(routine({ query_type: 'QUERY', bind_config: '' })));
});

test('바인드 설정의 누락·중복·방향·타입·크기·출력 조합을 검증한다', () => {
  const config = JSON.parse(routine().bind_config);
  for (const bind_config of ['', '[]', 'null', '{bad', '{}',
    JSON.stringify({ ...config, ID: config.id }),
    JSON.stringify({ ...config, extra: config.id }),
    JSON.stringify({ ...config, result: { dir: 'IN', type: 'CURSOR' } }),
    JSON.stringify({ ...config, result: { dir: 'OUT', type: 'CLOB' } }),
    JSON.stringify({ ...config, result: { dir: 'OUT', type: 'STRING', maxSize: 32768 } }),
    JSON.stringify({ ...config, result: { dir: 'OUT', type: 'STRING', maxSize: 0 } }),
    JSON.stringify({ ...config, result: { dir: 'OUT', type: 'NUMBER', val: 'injected' } }),
    JSON.stringify({ ...config, id: { dir: 'INOUT', type: 'STRING' } }),
  ]) assert.throws(() => validateAdminRecord('queries', routine({ bind_config })), { status: 400 });
  assert.throws(() => executionSpec(routine({ query_type: 'FUNCTION', query_sql: 'BEGIN :id := app.f(:result); END;' })));
});

test('프롬프트의 상세/축약 실행 명세 모두 OUT 값을 입력으로 요구하지 않는다', () => {
  for (const detail of [true, false]) {
    const prompt = buildPrompt({ question: '주문 조회', chat: [], knowledge: [], qaMethods: [], history: [],
      queries: [routine({ detail })] });
    assert.match(prompt, /유형\(PROCEDURE/);
    assert.match(prompt, /바인드\(:id\)/);
    assert.doesNotMatch(prompt, /바인드\([^)]*:result/);
  }
});
