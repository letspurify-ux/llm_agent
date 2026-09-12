// 실제 HTTP 서버/에이전트/Oracle 실행기를 사용한다. DB 드라이버와 LLM만 대체한다.
import mariadb from 'mariadb';
import oracledb from 'oracledb';
import { llm } from '../../src/llm.js';

const rows = [
  { seq: 1, query_name: 'fail_proc', query_type: 'PROCEDURE', query_sql: 'BEGIN app.fail_proc(:result); END;' },
  { seq: 2, query_name: 'fail_fn', query_type: 'FUNCTION', query_sql: 'BEGIN :result := app.fail_fn(); END;' },
  { seq: 3, query_name: 'healthy', query_type: 'QUERY', query_sql: 'SELECT 42 AS VALUE FROM dual' },
].map(row => ({ ...row, target_db_name: 'TEST', bind_config: row.query_type === 'QUERY' ? '' : '{"result":{"dir":"OUT","type":"STRING"}}' }));

mariadb.createPool = () => ({
  getConnection: async () => ({
    query: async (sql, params) => {
      if (/FROM query_registry/.test(sql)) return rows.filter(row => params?.includes(row.query_name));
      if (/FROM target_db/.test(sql)) return [{ db_name: 'TEST', db_type: 'oracle', connection_info: 'unused', db_user: 'reader', db_password: 'unused' }];
      return { affectedRows: 0 };
    },
    release: async () => {},
  }),
  end: async () => {},
});
oracledb.createPool = async () => ({
  getConnection: async () => ({
    execute(sql) {
      // 동기 throw와 비동기 rejection 모두 개별 조회에서 처리되어야 한다.
      if (sql.includes('fail_proc')) throw new Error('ORA-20001: procedure failed at PRIVATE_SCHEMA');
      if (sql.includes('fail_fn')) return Promise.reject(new Error('ORA-01476: divisor is equal to zero at PRIVATE_SCHEMA'));
      return Promise.resolve({ rows: [{ VALUE: 42 }] });
    },
    rollback: async () => {},
    close: async () => {},
  }),
  close: async () => {},
});
llm.decide = async ctx => {
  const call = query_name => ({ action: 'run_query', query_name, params: {} });
  if (ctx.question === 'batch' && !ctx.history.length) {
    return { action: 'run_queries', queries: rows.map(row => ({ query_name: row.query_name, params: {} })) };
  }
  if (ctx.question === 'sequential' && ctx.history.length < 3) return call(rows[ctx.history.length].query_name);
  if (ctx.question === 'healthy' && !ctx.history.length) return call('healthy');
  // 실패가 0건 성공으로 숨겨지거나 성공 결과가 유실되면 HTTP 테스트가 실패한다.
  const failed = ctx.history.filter(step => step.error).length;
  const good = ctx.history.some(step => step.query_name === 'healthy' && step.rows?.[0]?.VALUE === 42);
  return { action: 'answer', answer: good && failed === (ctx.question === 'healthy' ? 0 : 2) ? '후속 조회 완료' : '흐름 오류' };
};
await import('../../src/server.js');
