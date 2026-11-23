import { createScene } from './scene';
import { createPoseIkTab } from './tab-pose-ik';
import type { CharacterPose } from './character';

export interface TabHandle {
  mount(pose?: CharacterPose): void;
  unmount(): void;
  capturePose?(): CharacterPose | undefined;
}

export type PlaygroundContext = ReturnType<typeof createScene>;

const ctx = createScene(document.getElementById('app')!);
// 调试句柄：控制台可直接检查场景/页签内部状态（playground 惯例）
(window as unknown as { __threeik: unknown }).__threeik = {
  scene: ctx.scene,
  camera: ctx.camera,
  renderer: ctx.renderer,
  controls: ctx.controls,
};

async function start() {
  const poseControlView = { showAll: false };
  const tabs: Record<string, TabHandle> = {
    'Fullbody IK': createPoseIkTab(ctx, poseControlView, 'fullbody'),
    '原始 IK': createPoseIkTab(ctx, poseControlView, 'legacy'),
  };
  const tabsEl = document.getElementById('tabs')!;
  let active: TabHandle | null = null;
  let incomingPose: CharacterPose | undefined;
  for (const [name, tab] of Object.entries(tabs)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.onclick = () => {
      if (active === tab) return;
      incomingPose = active?.capturePose && tab.capturePose ? active.capturePose() ?? incomingPose : undefined;
      tabsEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      active?.unmount();
      active = tab;
      tab.mount(incomingPose);
    };
    tabsEl.appendChild(btn);
  }
  // 初始页签必须同步赋值 active，否则首次切页签时 active 为 null、初始页签永远不会 unmount（GUI/角色/帧回调全部泄漏）
  const first = Object.values(tabs)[0];
  if (first) {
    active = first;
    first.mount();
  }
  tabsEl.querySelector('button')?.classList.add('active');
}

start();
