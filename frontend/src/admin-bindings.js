const keyOf = name => name.trim().toLowerCase();
const outputString = row => row.type === 'STRING' && row.dir !== 'IN';

export function readBindings(raw) {
  try {
    const value = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : raw ?? {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    const rows = Object.entries(value).map(([name, config]) => {
      if (!config || typeof config !== 'object' || Array.isArray(config)
        || !['IN', 'OUT', 'INOUT'].includes(config.dir) || !['STRING', 'NUMBER', 'CURSOR'].includes(config.type)
        || Object.keys(config).some(k => !['dir', 'type', 'maxSize'].includes(k))) throw new Error();
      return { name, dir: config.dir, type: config.type, maxSize: config.maxSize == null ? '' : String(config.maxSize) };
    });
    return { rows, error: '' };
  } catch {
    return { rows: [], error: '기존 바인드 설정을 읽을 수 없습니다. 설정을 다시 만든 뒤 저장해주세요.' };
  }
}

// 조회 루틴의 :이름을 읽는다. 리터럴과 주석은 건너뛰며 반환값의 :=는 이름으로 보지 않는다.
export function sqlBindNames(sql) {
  const names = new Map();
  const tokens = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"[^"]*"|:([A-Za-z][A-Za-z0-9_$#]*)/g;
  for (const match of sql.matchAll(tokens)) if (match[1] && !names.has(keyOf(match[1]))) names.set(keyOf(match[1]), match[1]);
  return [...names.values()];
}

export function returnBindName(sql, type) {
  return type === 'FUNCTION' ? /^\s*BEGIN\s+:([A-Za-z][A-Za-z0-9_$#]*)\s*:=/i.exec(sql)?.[1] ?? '' : '';
}

export function importBindings(config, sql, type) {
  const existing = new Map(config.rows.map(row => [keyOf(row.name), row]));
  const result = keyOf(returnBindName(sql, type));
  // SQL에서 사라진 설정도 보존한다. 사용자가 삭제할 행을 직접 확인할 수 있다.
  const rows = config.rows.map(row => ({ ...row, ...(keyOf(row.name) === result && { dir: 'OUT' }) }));
  for (const name of sqlBindNames(sql)) {
    if (!existing.has(keyOf(name))) rows.push({ name, dir: keyOf(name) === result ? 'OUT' : 'IN', type: 'STRING', maxSize: '' });
  }
  return { rows, error: '' };
}

export function serializeBindings(config, sql, type) {
  if (type === 'QUERY') return '';
  if (config.error) throw new Error(config.error);
  const names = sqlBindNames(sql).map(keyOf);
  const result = keyOf(returnBindName(sql, type));
  const seen = new Set();
  const rows = config.rows.map((source, index) => {
    const row = { ...source, name: source.name.trim() };
    if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(row.name)) throw new Error(`${index + 1}번 바인드 이름을 확인해주세요. 영문자로 시작하는 128자 이내 이름을 입력하세요.`);
    const key = keyOf(row.name);
    if (seen.has(key)) throw new Error(`바인드 이름 '${row.name}'이 중복됩니다.`);
    seen.add(key);
    if (!names.includes(key)) throw new Error(`:${row.name}은 SQL에 없습니다. 이름을 수정하거나 해당 행을 삭제해주세요.`);
    if (key === result || row.type === 'CURSOR') row.dir = 'OUT';
    if (!['IN', 'OUT', 'INOUT'].includes(row.dir) || !['STRING', 'NUMBER', 'CURSOR'].includes(row.type)) throw new Error(`${index + 1}번 바인드의 방향과 자료형을 선택해주세요.`);
    const binding = { dir: row.dir, type: row.type };
    if (outputString(row) && row.maxSize !== '') {
      const size = Number(row.maxSize);
      if (!Number.isInteger(size) || size < 1 || size > 32767) throw new Error(`:${row.name}의 출력 크기는 1~32767바이트로 입력해주세요.`);
      binding.maxSize = size;
    }
    return [row.name, binding];
  });
  if (names.some(name => !seen.has(name))) throw new Error('설정이 없는 바인드가 있습니다. SQL에서 불러오기를 눌러 추가해주세요.');
  const outputs = rows.filter(([, row]) => row.dir !== 'IN');
  if (!outputs.length) throw new Error('출력(OUT 또는 INOUT) 바인드를 하나 이상 설정해주세요.');
  if (outputs.some(([, row]) => row.type === 'CURSOR') && outputs.length !== 1) throw new Error('커서 출력은 단독 1개만 사용할 수 있습니다. 다른 출력은 제거하거나 입력으로 변경해주세요.');
  if (rows.length - rows.filter(([, row]) => row.dir === 'OUT').length > 20 || outputs.length > 30) throw new Error('입력은 최대 20개, 출력은 최대 30개까지 설정할 수 있습니다.');
  return JSON.stringify(Object.fromEntries(rows));
}
