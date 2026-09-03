import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d21);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(2.5, 1.8, 3.2);
  camera.lookAt(0, 1, 0);

  // 视角控制：左键空白旋转 / 滚轮缩放 / 右键平移，target 对齐角色腰部
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.5;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.495; // 不钻到地面网格以下
  controls.update();

  // 拖球与 OrbitControls 共用 canvas 指针事件：球开始拖时禁用 controls、松手恢复，
  // 否则拖球视角会跟着转。用计数而非布尔——多点触控可同时拖两个球，最后一个松手才恢复。
  let dragLocks = 0;
  const dragControl = {
    lock(): void {
      dragLocks++;
      controls.enabled = false;
    },
    unlock(): void {
      dragLocks = Math.max(0, dragLocks - 1);
      if (dragLocks === 0) controls.enabled = true;
    },
  };

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
    controls.update(); // 阻尼需要逐帧 update
    renderer.render(scene, camera);
  });

  return {
    scene, camera, renderer, controls, dragControl,
    onFrame(cb: (dt: number) => void): () => void {
      frameCbs.push(cb);
      return () => {
        const i = frameCbs.indexOf(cb);
        if (i >= 0) frameCbs.splice(i, 1);
      };
    },
  };
}
