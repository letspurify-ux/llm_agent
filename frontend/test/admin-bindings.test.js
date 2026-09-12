import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBindings, serializeBindings, importBindings, sqlBindNames } from '../src/admin-bindings.js';

const sql = 'BEGIN :result := app.total(:id); END;';
test('기존 JSON의 방향/자료형/출력 크기를 폼 왕복 시 보존하고 QUERY는 설정을 비운다', () => {
  const json = '{"id":{"dir":"INOUT","type":"NUMBER"},"result":{"dir":"OUT","type":"STRING","maxSize":2048}}';
  const form = readBindings(json);
  assert.deepEqual(JSON.parse(serializeBindings(form, sql, 'FUNCTION')), JSON.parse(json));
  assert.equal(serializeBindings(form, 'SELECT :id FROM dual', 'QUERY'), '');
  assert.equal(serializeBindings(readBindings('{broken'), '', 'QUERY'), '');
});
test('SQL 불러오기는 중복을 제거하고 기존 설정과 미사용 행을 보존하며 함수 반환값은 OUT으로 설정한다', () => {
  const config = readBindings('{"ID":{"dir":"INOUT","type":"NUMBER"},"unused":{"dir":"IN","type":"STRING"}}');
  const form = importBindings(config, sql, 'FUNCTION');
  assert.deepEqual(importBindings(form, sql, 'FUNCTION'), form);
  assert.deepEqual(form.rows[0], config.rows[0]);
  assert.equal(form.rows[1].name, 'unused');
  assert.equal(form.rows[2].dir, 'OUT');
  assert.throws(() => serializeBindings(form, sql, 'FUNCTION'), /SQL에 없습니다/);
  assert.deepEqual(sqlBindNames("BEGIN p(:id,:ID, :result); END; -- :ignored\n/* :skip */ ':literal'"), ['id', 'result']);
});
test('잘못된 기존 JSON·중복·누락·출력 크기를 저장 전에 거부한다', () => {
  for (const raw of ['{broken', '[]', 'null', '{"id":null}', '{"id":{"dir":"IN","type":"OBJECT"}}']) {
    const form = readBindings(raw);
    assert.ok(form.error);
    assert.throws(() => serializeBindings(form, sql, 'FUNCTION'));
  }
  const form = importBindings(readBindings(''), sql, 'FUNCTION');
  form.rows.push({ ...form.rows[0], name: 'RESULT' });
  assert.throws(() => serializeBindings(form, sql, 'FUNCTION'), /중복/);
  form.rows.pop(); form.rows[0].maxSize = '32768';
  assert.throws(() => serializeBindings(form, sql, 'FUNCTION'), /출력 크기/);
  form.rows[0].maxSize = ''; form.rows.pop();
  assert.throws(() => serializeBindings(form, sql, 'FUNCTION'), /설정이 없는 바인드/);
});
