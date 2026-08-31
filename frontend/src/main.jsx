import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// 수식 스타일시트. KaTeX는 span 더미로 수식을 조립하므로 이 CSS가 없으면 화면에 기호가
// 뒤엉켜 나온다(렌더는 성공하므로 오류로는 보이지 않는다). 폰트 파일은 vite가 함께 번들한다.
import 'katex/dist/katex.min.css';

createRoot(document.getElementById('root')).render(<App />);
