import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 외부(다른 PC) 접속 허용. vite는 기본적으로 localhost에만 바인딩해서 같은 PC에서만 열린다 —
// true면 모든 인터페이스(0.0.0.0)에 붙어 사내망의 다른 PC가 `http://<이 PC의 IP>:5173`으로 들어온다.
// 기동 로그의 Network: 줄에 그 주소가 찍히니 거기서 확인한다.
// 다시 내 PC만으로 닫으려면 FRONTEND_HOST=localhost 로 띄운다.
const host = process.env.FRONTEND_HOST || true;

// vite 5.4.12+는 Host 헤더를 검사해서 모르는 이름은 "Blocked request"로 막는다. IP와 localhost는
// 기본 통과하지만 도메인 이름(agent.corp.local 등)으로 붙으면 host를 열어둬도 여기서 걸린다 —
// 그 이름을 등록해야 뚫린다: FRONTEND_ALLOWED_HOSTS=agent.corp.local,voc.example.com
// 빈 값이면 아예 넘기지 않는다 — 빈 배열을 주면 IP 접속까지 같이 막힌다.
const allowedHosts = (process.env.FRONTEND_ALLOWED_HOSTS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const server = {
  host,
  ...(allowedHosts.length ? { allowedHosts } : {}),
  // 백엔드 포트의 사본 — backend/.env의 PORT를 바꿨다면 여기가 조용히 어긋난다.
  // 그때는 BACKEND_PORT로 맞춘다: BACKEND_PORT=4001 npm run dev
  // 프록시는 vite 프로세스가 직접 호출하므로 목적지는 외부 접속 여부와 무관하게 localhost 그대로다
  // (브라우저가 아니라 이 PC가 백엔드를 부른다 — 그래서 백엔드는 외부에 열 필요도, CORS도 없다).
  proxy: { '/api': `http://localhost:${process.env.BACKEND_PORT || 3001}` },
};

export default defineConfig({
  plugins: [react()],
  server,
  // `npm run build` 결과를 확인하는 preview 서버도 같은 규칙으로 연다 — 한쪽만 열어두면
  // dev에서 되던 외부 접속이 preview에서만 안 되는 이유를 찾느라 시간을 버린다.
  // 같은 객체를 그대로 넘기지 않고 복사한다: 두 모드가 한 객체를 공유하면 vite가 설정을
  // 정규화하며 손대는 순간 한쪽 변경이 다른 쪽으로 새고, 그 인과는 추적하기 어렵다.
  preview: { ...server },
});
