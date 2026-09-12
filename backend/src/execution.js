// 등록 실행 명세. LLM은 IN/INOUT 값만 채우며 실행 종류와 OUT 설정은 관리자가 정한다.
import { assertReadOnly, bindNames } from './sql.js';
import { MAX_BIND_NAME_LEN, MAX_RESULT_COLS, nameKey, safeError, isPlainObject } from './constants.js';

export function queryType(row) {
  const type = row.query_type ?? 'QUERY';
  if (!['QUERY', 'PROCEDURE', 'FUNCTION'].includes(type)) throw safeError('실행 유형은 QUERY, PROCEDURE, FUNCTION 중 하나여야 합니다.');
  return type;
}

function bindingConfig(value) {
  let config = value;
  if (config == null || config === '') return {};
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { throw safeError('바인드 설정은 JSON 객체여야 합니다.'); }
  }
  if (!isPlainObject(config)) throw safeError('바인드 설정은 JSON 객체여야 합니다.');
  return config;
}

export function executionSpec(row) {
  const type = queryType(row);
  const config = bindingConfig(row.bind_config);
  if (type === 'QUERY') {
    if (Object.keys(config).length) throw safeError('QUERY는 바인드 설정을 비워주세요. 입력 바인드는 SQL에서 자동으로 추출합니다.');
    return { type, sql: assertReadOnly(row.query_sql), inputs: bindNames(row.query_sql), bindings: [] };
  }
  // 임의 PL/SQL 블록을 허용하지 않는다. 등록된 루틴 한 번 호출과 바인드만 허용한다.
  // 원문 전체를 검사하므로 리터럴/주석 제거 과정에서 인수가 사라지는 일도 없다.
  const ident = '[A-Za-z][A-Za-z0-9_$#]{0,127}';
  const target = `${ident}(?:\\s*\\.\\s*${ident}){0,2}`;
  const arg = `(?:${ident}\\s*=>\\s*)?:${ident}`;
  const args = `(?:${arg}(?:\\s*,\\s*${arg})*)?`;
  const assignment = type === 'FUNCTION' ? `:(${ident})\\s*:=\\s*` : '';
  const pattern = new RegExp(`^\\s*BEGIN\\s+${assignment}${target}\\s*\\(\\s*${args}\\s*\\)\\s*;\\s*END\\s*;\\s*$`, 'i');
  const match = typeof row.query_sql === 'string' && pattern.exec(row.query_sql);
  if (!match) throw safeError(type === 'FUNCTION'
    ? '함수는 BEGIN :result := schema.function_name(:input); END; 형식으로 등록해주세요.'
    : '프로시저는 BEGIN schema.procedure_name(:input, :output); END; 형식으로 등록해주세요.');
  const names = bindNames(row.query_sql);
  const entries = Object.entries(config);
  const keys = entries.map(([name]) => nameKey(name));
  if (keys.length !== new Set(keys).size || entries.some(([name]) =>
    name.length > MAX_BIND_NAME_LEN || !names.some(n => nameKey(n) === nameKey(name)))) {
    throw safeError('바인드 설정에 중복되거나 SQL에 없는 이름이 있습니다.');
  }
  const bindings = names.map(name => {
    const entry = entries.find(([key]) => nameKey(key) === nameKey(name))?.[1];
    if (!isPlainObject(entry) || !['IN', 'OUT', 'INOUT'].includes(entry.dir)
      || !['STRING', 'NUMBER', 'CURSOR'].includes(entry.type)
      || Object.keys(entry).some(k => !['dir', 'type', 'maxSize'].includes(k))) {
      throw safeError(`:${name}의 dir(IN/OUT/INOUT), type(STRING/NUMBER/CURSOR)을 설정해주세요.`);
    }
    if (entry.type === 'CURSOR' && entry.dir !== 'OUT') throw safeError('CURSOR는 OUT 방향만 지원합니다.');
    const stringOutput = entry.type === 'STRING' && entry.dir !== 'IN';
    if (entry.maxSize !== undefined && (!stringOutput || !Number.isInteger(entry.maxSize) || entry.maxSize < 1 || entry.maxSize > 32767)) {
      throw safeError('maxSize는 STRING OUT/INOUT에만 지정할 수 있으며 1~32767바이트여야 합니다.');
    }
    return { name, dir: entry.dir, type: entry.type, ...(stringOutput && { maxSize: entry.maxSize ?? 32767 }) };
  });
  const inputs = bindings.filter(b => b.dir !== 'OUT').map(b => b.name);
  const outputs = bindings.filter(b => b.dir !== 'IN');
  if (inputs.length > 20 || outputs.length > MAX_RESULT_COLS || !outputs.length) {
    throw safeError(`루틴은 입력 최대 20개, 출력 1~${MAX_RESULT_COLS}개가 필요합니다.`);
  }
  if (outputs.some(b => b.type === 'CURSOR') && outputs.length !== 1) {
    throw safeError('CURSOR 출력은 단독 1개만 지원합니다. 여러 스칼라 출력과 함께 사용할 수 없습니다.');
  }
  if (type === 'FUNCTION' && !outputs.some(b => nameKey(b.name) === nameKey(match[1]) && b.dir === 'OUT')) {
    throw safeError('함수 반환 바인드는 OUT으로 설정해주세요.');
  }
  return { type, sql: numericLocals(row.query_sql.trim(), bindings), inputs, bindings };
}

// NUMBER를 드라이버의 JS number로 받으면 큰 정수가 반올림된다. 전송은 STRING으로 하되
// 실제 호출 인수는 NUMBER 지역 변수로 만들어 오버로드 선택과 INOUT 타입까지 보존한다.
function numericLocals(sql, bindings) {
  const numbers = bindings.filter(b => b.type === 'NUMBER');
  if (!numbers.length) return sql;
  let prefix = 'agent_number_';
  while (sql.toLowerCase().includes(prefix)) prefix += 'x';
  const vars = numbers.map((b, i) => ({ ...b, local: `${prefix}${i}` }));
  const byName = new Map(vars.map(b => [nameKey(b.name), b.local]));
  const body = sql.replace(/^BEGIN\s+/i, '').replace(/END\s*;$/i, '')
    .replace(/:([A-Za-z][A-Za-z0-9_$#]*)/g, (token, name) => byName.get(nameKey(name)) ?? token);
  return `DECLARE ${vars.map(b => `${b.local} NUMBER;`).join(' ')} BEGIN `
    + vars.filter(b => b.dir !== 'OUT').map(b => `${b.local} := :${b.name};`).join(' ')
    + ` ${body} `
    + vars.filter(b => b.dir !== 'IN').map(b => `:${b.name} := ${b.local};`).join(' ')
    + ' END;';
}

// 잘못된 기존 등록 한 건이 전체 검색/프롬프트를 중단하지 않게 한다. 실행 시에는 반드시 재검증한다.
export function inputBindNames(row) {
  if (row.query_type == null || row.query_type === 'QUERY') return bindNames(row.query_sql);
  try { return executionSpec(row).inputs; } catch { return []; }
}
