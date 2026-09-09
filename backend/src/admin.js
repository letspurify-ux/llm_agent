import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { query, getConnection, releaseConnection } from './db.js';
import { assertReadOnly } from './sql.js';
import { nameIndexOf, targetDbNames } from './constants.js';

const resources = {
  databases: { table: 'target_db', name: 'db_name', summary: 'connection_info', fields: {
    db_name: [100, true], db_type: [20, true], connection_info: [500, true],
    db_user: [100, true], db_password: [200, true],
  } },
  knowledge: { table: 'knowledge', name: 'title', summary: 'content', fields: {
    title: [200, true], content: [null, true],
  } },
  methods: { table: 'qa_method', name: 'title', summary: 'method', fields: {
    title: [200, true], method: [null, true],
  } },
  queries: { table: 'query_registry', name: 'query_name', summary: 'query_desc', fields: {
    query_name: [100, true], query_desc: [null, false], input_desc: [1000, false],
    query_sql: [null, true], output_desc: [null, false], target_db_name: [500, true],
  } },
};
const labels = { db_name: 'DB 이름', db_type: 'DB 유형', connection_info: '접속 주소',
  db_user: '조회 대상 DB 사용자명', db_password: '조회 대상 DB 비밀번호', title: '제목', content: '지식 본문',
  method: '처리 방법', query_name: '쿼리 이름', query_desc: '쿼리 설명', input_desc: '입력 설명',
  query_sql: 'SQL', output_desc: '출력 설명', target_db_name: '대상 DB' };
const problem = (status, message) => Object.assign(new Error(message), { status });
// 비밀번호 변경도 감지하되, 공개 revision에서 비밀번호를 사전 대입할 수 없게 HMAC을 쓴다.
// 서버 재시작 후 열린 편집기는 다시 읽어야 한다. 스키마를 바꾸거나 비밀번호를 클라이언트로 보내지 않는다.
const revisionKey = randomBytes(32);
const recordRevision = (kind, fingerprint) => createHmac('sha256', revisionKey).update(`${kind}:${fingerprint}`).digest('hex');
function requireRevision(revision) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw problem(428, '항목을 다시 열어 최신 내용을 확인한 뒤 저장하거나 삭제해주세요.');
  }
}
function checkRevision(row, revision) {
  if (row.revision !== revision) throw problem(409, '이 항목은 다른 화면에서 변경되었습니다. 입력 내용을 보관한 뒤 항목을 다시 열어 확인해주세요.');
}
// ECMAScript String.trim()의 공백 집합. SQL TRIM은 탭·개행 등을 제거하지 않으므로
// 실행 경계(targetDbNames)와 같은 이름을 비교하려면 명시적인 공백 집합이 필요하다.
const trimSpace = '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';
const trimPattern = `^${trimSpace}+|${trimSpace}+$`;
function resource(kind) {
  if (!Object.hasOwn(resources, kind)) throw problem(404, '관리 항목을 찾을 수 없습니다.');
  return resources[kind];
}
function recordId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || Number(value) > 2147483647) {
    throw problem(400, '올바른 항목 번호가 필요합니다.');
  }
  return Number(value);
}
function publicColumns(config) {
  return ['seq', ...Object.keys(config.fields).filter(f => f !== 'db_password'),
    ...(config.table === 'target_db' ? ["(db_password IS NOT NULL AND db_password <> '') AS has_password"] : []),
    `SHA2(JSON_ARRAY(seq, ${Object.keys(config.fields).join(', ')}), 256) AS _fingerprint`,
  ].join(', ');
}

export function validateAdminRecord(kind, body, editing = false) {
  const config = resource(kind);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, '입력 내용을 확인해주세요.');
  const result = {};
  for (const [key, [limit, required]] of Object.entries(config.fields)) {
    const raw = Object.hasOwn(body, key) ? body[key] : '';
    if (typeof raw !== 'string') throw problem(400, `${labels[key]}은(는) 문자열이어야 합니다.`);
    // 본문·SQL과 비밀번호의 원문 공백은 보존한다.
    const value = ['content', 'method', 'query_sql', 'db_password'].includes(key) ? raw : raw.trim();
    if (key === 'db_password' && editing && value === '') continue;
    if (required && !value.trim()) throw problem(400, `${labels[key]}을(를) 입력해주세요.`);
    if (limit ? Array.from(value).length > limit : Buffer.byteLength(value, 'utf8') > 65535) {
      throw problem(400, `${labels[key]}이(가) 너무 깁니다. ${limit ? `${limit}자` : 'UTF-8 기준 65,535바이트'} 이내로 입력해주세요.`);
    }
    if (value.includes('\0')) throw problem(400, `${labels[key]}에 사용할 수 없는 문자가 있습니다.`);
    result[key] = value;
  }
  if (kind === 'databases') {
    if (result.db_type !== 'oracle') throw problem(400, '현재 조회 DB는 Oracle만 지원합니다.');
    if (result.db_name.includes(';')) throw problem(400, 'DB 이름에는 세미콜론을 사용할 수 없습니다.');
    if (result.db_password?.startsWith('ENV:') && !/^ENV:[A-Za-z_][A-Za-z0-9_]*$/.test(result.db_password)) {
      throw problem(400, '환경변수 참조는 ENV:변수명 형식으로 입력해주세요.');
    }
  }
  if (kind === 'queries') {
    try { assertReadOnly(result.query_sql); } catch (e) { throw problem(400, e.message); }
    const names = targetDbNames(result.target_db_name);
    if (!names.length) throw problem(400, '대상 DB를 하나 이상 선택해주세요.');
    result.target_db_name = names.join(';');
  }
  return result;
}

// 모든 관리자 쓰기를 한 연결에서 직렬화한다. 참조 검사와 실제 변경 사이에 다른
// 관리자 요청이 DB를 삭제하거나 새 쿼리를 등록하는 틈을 막는다.
async function writeTransaction(fn) {
  const conn = await getConnection();
  let locked = false;
  try {
    const [row] = await conn.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':admin'), 5) AS acquired");
    if (Number(row.acquired) !== 1) throw problem(409, '다른 설정을 저장 중입니다. 잠시 후 다시 시도해주세요.');
    locked = true;
    await conn.beginTransaction();
    try {
      const result = await fn((sql, params = []) => conn.query(sql, params));
      await conn.commit();
      return result;
    } catch (e) { await conn.rollback(); throw e; }
  } finally {
    if (locked) {
      try { await conn.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':admin'))"); }
      catch { conn.destroy(); }
    }
    await releaseConnection(conn);
  }
}

export function createAdminStore(read = query, transaction = writeTransaction) {
  const get = async (kind, id, run = read, lock = false) => {
    const config = resource(kind);
    const [row] = await run(`SELECT ${publicColumns(config)} FROM ${config.table} WHERE seq = ?${lock ? ' FOR UPDATE' : ''}`, [recordId(id)]);
    if (!row) throw problem(404, '항목이 없거나 이미 삭제되었습니다. 목록을 새로고침해주세요.');
    const { _fingerprint, ...visible } = row;
    return { ...visible, revision: recordRevision(kind, _fingerprint) };
  };
  const checkReferences = async (kind, row, run) => {
    if (kind === 'databases') {
      // 비교는 관리 DB의 collation으로 한다. 대소문자·악센트 규칙이 DB 조회와 같아야 한다.
      const refs = await run(`SELECT q.query_name FROM query_registry q
        JOIN JSON_TABLE(CONCAT('[', REPLACE(JSON_QUOTE(q.target_db_name), ';', '\",\"'), ']'),
          '$[*]' COLUMNS (db_name VARCHAR(500) PATH '$')) AS names
        JOIN target_db t ON t.db_name = REGEXP_REPLACE(names.db_name, ?, '')
        WHERE t.seq = ? LIMIT 1`, [trimPattern, row.seq]);
      if (refs.length) throw problem(409, `이 조회 대상 DB는 쿼리 '${refs[0].query_name}'에서 사용 중입니다. 대상 DB 설정을 먼저 변경해주세요.`);
    }
    if (kind === 'queries') {
      const methods = await run('SELECT title, method FROM qa_method');
      const ref = methods.find(m => nameIndexOf(m.method, row.query_name) >= 0);
      if (ref) throw problem(409, `이 쿼리는 처리 방법 '${ref.title}'에서 사용 중입니다. 처리 방법을 먼저 변경해주세요.`);
    }
  };
  return {
    get,
    async list(kind, { q = '', page = '1' } = {}) {
      const config = resource(kind);
      if (typeof q !== 'string' || q.length > 200 || !/^[1-9]\d{0,5}$/.test(String(page))) {
        throw problem(400, '검색어나 페이지 번호를 확인해주세요.');
      }
      const searchable = Object.keys(config.fields).filter(f => f !== 'db_password');
      const where = q.trim() ? `WHERE ${searchable.map(f => `LOCATE(?, ${f}) > 0`).join(' OR ')}` : '';
      const params = where ? searchable.map(() => q.trim()) : [];
      const [count] = await read(`SELECT COUNT(*) AS total FROM ${config.table} ${where}`, params);
      const total = Number(count.total);
      const currentPage = Math.min(Number(page), Math.max(1, Math.ceil(total / 20)));
      const items = await read(`SELECT seq, ${config.name} AS name, LEFT(${config.summary}, 160) AS summary
        FROM ${config.table} ${where} ORDER BY seq DESC LIMIT 20 OFFSET ?`, [...params, (currentPage - 1) * 20]);
      return { items, total, page: currentPage, pageSize: 20 };
    },
    async databaseOptions() {
      return read('SELECT seq, db_name FROM target_db ORDER BY db_name');
    },
    async save(kind, body, id, revision) {
      const config = resource(kind);
      if (id != null) requireRevision(revision);
      const values = validateAdminRecord(kind, body, id != null);
      return transaction(async run => {
        if (id != null) {
          const old = await get(kind, id, run, true);
          checkRevision(old, revision);
          if (['databases', 'queries'].includes(kind) && old[config.name] !== values[config.name]) {
            await checkReferences(kind, old, run);
          }
        }
        if (kind === 'queries') {
          const names = targetDbNames(values.target_db_name);
          const rows = await run(`SELECT db_name FROM target_db WHERE db_name IN (${names.map(() => '?').join(',')})`, names);
          if (rows.length !== names.length) throw problem(400, '등록되지 않은 조회 대상 DB가 있습니다. 조회 대상 DB 탭에서 먼저 등록해주세요.');
          values.target_db_name = rows.map(r => r.db_name).join(';');
        }
        const fields = Object.keys(values);
        if (id != null) {
          await run(`UPDATE ${config.table} SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE seq = ?`, [...Object.values(values), recordId(id)]);
        } else {
          const result = await run(`INSERT INTO ${config.table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, Object.values(values));
          id = Number(result.insertId);
        }
        return get(kind, id, run);
      });
    },
    async remove(kind, id, revision) {
      const config = resource(kind);
      requireRevision(revision);
      return transaction(async run => {
        const row = await get(kind, id, run, true);
        checkRevision(row, revision);
        await checkReferences(kind, row, run);
        await run(`DELETE FROM ${config.table} WHERE seq = ?`, [recordId(id)]);
      });
    },
  };
}

export function createAdminRouter({ store = createAdminStore(), token = process.env.ADMIN_TOKEN || '' } = {}) {
  const router = express.Router();
  const revision = req => /^"([a-f0-9]{64})"$/.exec(req.get('If-Match') || '')?.[1];
  const record = (res, row, status = 200) => res.status(status).set('ETag', `"${row.revision}"`).json(row);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // 교차 출처 폼 제출을 받지 않는다. 이 헤더는 same-origin UI만 보낼 수 있다(CORS 미허용).
    if (req.get('X-Admin-Request') !== '1') return res.status(403).json({ error: '관리자 화면에서 다시 시도해주세요.' });
    if (token) {
      const hash = s => createHash('sha256').update(s).digest();
      if (!timingSafeEqual(hash(req.get('X-Admin-Token') || ''), hash(token))) {
        return res.status(401).json({ error: '관리자 인증 키를 입력해주세요.' });
      }
    }
    next();
  });
  router.use(express.json({ limit: '1mb' }));
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const duplicate = e.code === 'ER_DUP_ENTRY';
      const denied = ['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(e.code);
      const status = e.status || (duplicate ? 409 : denied ? 503 : 500);
      // 드라이버 message에는 SQL과 비밀번호가 들어갈 수 있으므로 출력하지 않는다.
      if (status >= 500) console.warn('[admin] request failed:', e.code || 'unknown');
      res.status(status).json({ error: e.status ? e.message : duplicate ? '같은 이름의 항목이 이미 있습니다.'
        : denied ? '관리 DB 계정에 설정 변경 권한이 없습니다. 서버의 DB 권한 설정을 확인해주세요.'
          : '관리 데이터를 처리하지 못했습니다. DB 연결 상태를 확인한 뒤 다시 시도해주세요.' });
    }
  };
  router.get('/database-options', handle(async (req, res) => res.json({ items: await store.databaseOptions() })));
  router.get('/:resource', handle(async (req, res) => res.json(await store.list(req.params.resource, req.query))));
  router.get('/:resource/:id', handle(async (req, res) => record(res, await store.get(req.params.resource, req.params.id))));
  router.post('/:resource', handle(async (req, res) => record(res, await store.save(req.params.resource, req.body), 201)));
  router.put('/:resource/:id', handle(async (req, res) => record(res, await store.save(req.params.resource, req.body, req.params.id, revision(req)))));
  router.delete('/:resource/:id', handle(async (req, res) => { await store.remove(req.params.resource, req.params.id, revision(req)); res.status(204).end(); }));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.status === 413 ? '입력 내용이 너무 큽니다.' : '입력 내용을 읽지 못했습니다.' });
  });
  return router;
}
