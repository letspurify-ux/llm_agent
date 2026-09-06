// CLI도 통합 테스트가 만든 Unix 소켓만 사용한다.
import mariadb from 'mariadb';
if (!process.env.BACKEND_TEST_DB_SOCKET) throw new Error('BACKEND_TEST_DB_SOCKET is required');
const createPool = mariadb.createPool.bind(mariadb);
mariadb.createPool = options => {
  const pool = createPool({ ...options, socketPath: process.env.BACKEND_TEST_DB_SOCKET, user: 'root', password: '', database: 'llm_agent' });
  const end = pool.end.bind(pool);
  pool.end = async () => { await end(); console.log('[test] pool closed'); };
  return pool;
};
globalThis.fetch = async (_url, init) => {
  const { input } = JSON.parse(init.body);
  const dimensions = process.env.BACKEND_TEST_BAD_VECTOR ? 1 : 1024;
  return new Response(JSON.stringify({ data: input.map((_, index) => ({
    index, embedding: Array.from({ length: dimensions }, (_, i) => Number(i === 0)),
  })) }));
};
