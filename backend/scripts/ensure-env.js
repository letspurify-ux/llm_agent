// 개발 실행(npm run dev) 전 .env 부트스트랩.
// .env는 gitignore 대상이라 새로 클론한 저장소에는 없다. 없는 채로 서버를 띄우면
// ORACLE_MOCK이 미설정이라 실제 Oracle 접속 경로를 타고(자격증명은 비어 있다) 모든 질문이 500이 된다 —
// README 2단계(cp .env.example .env)를 실행 경로 안으로 옮겨 그 함정을 없앤다.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = join(root, '.env');
if (!existsSync(env)) {
  copyFileSync(join(root, '.env.example'), env);
  console.log('[setup] .env가 없어 .env.example로 생성했습니다 (ORACLE_MOCK=1 개발 기본값). MARIADB_PASSWORD는 비어 있으니 채워야 관리 DB에 접속됩니다.');
}
