import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 백엔드 포트의 사본 — backend/.env의 PORT를 바꿨다면 여기가 조용히 어긋난다.
    // 그때는 BACKEND_PORT로 맞춘다: BACKEND_PORT=4001 npm run dev
    proxy: { '/api': `http://localhost:${process.env.BACKEND_PORT || 3001}` },
  },
});
