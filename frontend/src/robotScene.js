import * as THREE from 'three';

export function mountRobot(host) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
  camera.position.set(0, 0.15, 6.3);
  camera.lookAt(0, 0.1, 0);
  scene.add(new THREE.HemisphereLight(0xd9f2ff, 0x284470, 2.5));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-3, 4, 5);
  scene.add(light);
  const robot = new THREE.Group();
  scene.add(robot);
  const shell = new THREE.MeshStandardMaterial({ color: 0xeef6ff, roughness: 0.28, metalness: 0.15 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.3, metalness: 0.25 });
  const visor = new THREE.MeshStandardMaterial({ color: 0x092544, roughness: 0.2 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });
  function sphere(parent, material, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  }
  sphere(robot, shell, 0, -0.62, 0, 0.47, 0.5, 0.33);
  sphere(robot, blue, 0, -0.58, 0.3, 0.2, 0.22, 0.07);
  sphere(robot, glow, 0, -0.56, 0.37, 0.065, 0.065, 0.025);
  const head = new THREE.Group();
  head.position.y = 0.35;
  robot.add(head);
  sphere(head, shell, 0, 0, 0, 0.87, 0.68, 0.53);
  sphere(head, visor, 0, -0.03, 0.4, 0.7, 0.43, 0.22);
  const eyes = [-0.27, 0.27].map(x => sphere(head, glow, x, 0.03, 0.6, 0.085, 0.14, 0.045));
  const smileCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-0.13, -0.19, 0.615), new THREE.Vector3(0, -0.3, 0.64), new THREE.Vector3(0.13, -0.19, 0.615));
  head.add(new THREE.Mesh(new THREE.TubeGeometry(smileCurve, 12, 0.018, 6, false), glow));
  sphere(head, blue, -0.86, 0, 0, 0.13, 0.24, 0.23);
  sphere(head, blue, 0.86, 0, 0, 0.13, 0.24, 0.23);
  sphere(head, blue, 0, 0.72, 0, 0.045, 0.15, 0.045);
  const antenna = sphere(head, glow, 0, 0.89, 0, 0.1, 0.1, 0.1);
  const arms = [-1, 1].map(side => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.48, -0.39, 0);
    robot.add(pivot);
    sphere(pivot, blue, side * 0.1, -0.18, 0, 0.15, 0.3, 0.17);
    return pivot;
  });
  [-1, 1].forEach(side => sphere(robot, blue, side * 0.25, -1.05, 0.1, 0.2, 0.12, 0.25));
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let lost = false;
  let targetX = 0;
  let targetY = 0;
  let time = 0;
  let last = 0;
  function frame(now) {
    time += last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    const t = motion.matches ? 0 : time;
    robot.position.y = Math.sin(t * 2) * 0.065;
    robot.rotation.z = Math.sin(t * 1.3) * 0.035;
    head.rotation.y += ((motion.matches ? 0 : targetX * 0.35 + Math.sin(t * 0.8) * 0.09) - head.rotation.y) * 0.09;
    head.rotation.x += ((motion.matches ? 0 : targetY * 0.2) - head.rotation.x) * 0.09;
    const blink = t % 4.3;
    eyes.forEach(eye => { eye.scale.y = 0.14 * (blink > 3.95 && blink < 4.13 ? 0.12 : 1); });
    arms[0].rotation.z = -0.15 + Math.sin(t * 2) * 0.08;
    arms[1].rotation.z = 0.8 + Math.sin(t * 3) * 0.22;
    antenna.scale.setScalar(0.1 + Math.sin(t * 2) * 0.008);
    renderer.render(scene, camera);
  }
  function sync() {
    renderer.setAnimationLoop(null);
    last = 0;
    if (lost || !visible || document.hidden) return;
    frame(performance.now());
    if (!motion.matches) renderer.setAnimationLoop(frame);
  }
  function resize() {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    camera.aspect = width / (height || 1);
    camera.updateProjectionMatrix();
    sync();
  }
  function pointer(event) {
    const rect = host.getBoundingClientRect();
    targetX = THREE.MathUtils.clamp((event.clientX - rect.left - rect.width / 2) / 250, -1, 1);
    targetY = THREE.MathUtils.clamp((event.clientY - rect.top - rect.height / 2) / 250, -1, 1);
  }
  function reset() { targetX = 0; targetY = 0; }
  function contextLost(event) { event.preventDefault(); lost = true; host.classList.remove('robot-ready'); sync(); }
  function contextRestored() { lost = false; sync(); host.classList.add('robot-ready'); }
  const observer = new ResizeObserver(resize);
  const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);
  resize();
  host.classList.add('robot-ready');
  observer.observe(host);
  intersection.observe(host);
  window.addEventListener('pointermove', pointer, { passive: true });
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
  return () => {
    renderer.setAnimationLoop(null);
    observer.disconnect();
    intersection.disconnect();
    window.removeEventListener('pointermove', pointer);
    window.removeEventListener('blur', reset);
    document.removeEventListener('visibilitychange', sync);
    motion.removeEventListener('change', sync);
    renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
    scene.traverse(object => { object.geometry?.dispose(); });
    [shell, blue, visor, glow].forEach(material => material.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    host.classList.remove('robot-ready');
  };
}
