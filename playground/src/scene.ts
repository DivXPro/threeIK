import * as THREE from 'three';

export function createScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d21);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(2.5, 1.8, 3.2);
  camera.lookAt(0, 1, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(3, 6, 4);
  scene.add(dir);
  scene.add(new THREE.GridHelper(10, 20, 0x334155, 0x1f2937));

  const frameCbs: Array<(dt: number) => void> = [];
  const clock = new THREE.Clock();
  function resize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const cb of frameCbs) cb(dt);
    renderer.render(scene, camera);
  });

  return {
    scene, camera, renderer,
    onFrame(cb: (dt: number) => void) { frameCbs.push(cb); },
  };
}
