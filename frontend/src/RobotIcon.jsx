import { useEffect, useRef } from 'react';

export default function RobotIcon() {
  const host = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let dispose;
    import('./robotScene.js').then(({ mountRobot }) => {
      if (!cancelled) {
        try { dispose = mountRobot(host.current); } catch { /* Keep the static robot when WebGL is unavailable. */ }
      }
    }).catch(() => {});
    return () => { cancelled = true; dispose?.(); };
  }, []);
  return <span ref={host} className="robot-icon" aria-hidden="true">
    <svg className="robot-fallback" viewBox="0 0 48 48" fill="none">
      <rect x="16" y="31" width="16" height="11" rx="5" fill="#93c5fd" />
      <rect x="7" y="9" width="34" height="27" rx="11" fill="#eff6ff" />
      <rect x="11" y="15" width="26" height="16" rx="7" fill="#123052" />
      <path d="M18 21v3m12-3v3" stroke="#67e8f9" strokeWidth="4" strokeLinecap="round" />
      <path d="M21 27q3 3 6 0" stroke="#67e8f9" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M24 9V5" stroke="#93c5fd" strokeWidth="2" /><circle cx="24" cy="4" r="2" fill="#67e8f9" />
    </svg>
  </span>;
}
