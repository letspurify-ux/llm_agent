import { useEffect, useRef } from 'react';

export default function RobotIcon() {
  const host = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let dispose;
    import('./robotScene.js').then(({ mountRobot }) => {
      if (!cancelled) {
        try { dispose = mountRobot(host.current); } catch { /* Keep only the background when WebGL is unavailable. */ }
      }
    }).catch(() => {});
    return () => { cancelled = true; dispose?.(); };
  }, []);
  return <span ref={host} className="robot-icon" aria-hidden="true" />;
}
