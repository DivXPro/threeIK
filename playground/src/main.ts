import { createScene } from './scene';
import { createIkTab } from './tab-ik';
import { createConstraintsTab } from './tab-constraints';
import { createRetargetTab } from './tab-retarget';
import { createAnimIkTab } from './tab-anim-ik';

export interface TabHandle {
  mount(): void;
  unmount(): void;
}

export type PlaygroundContext = ReturnType<typeof createScene>;

const { scene, camera, renderer, onFrame } = createScene(document.getElementById('app')!);
// 调试句柄：控制台可直接检查场景/页签内部状态（playground 惯例）
(window as unknown as { __threeik: unknown }).__threeik = { scene, camera, renderer };

async function start() {
  const tabs: Record<string, TabHandle> = {
    'IK': createIkTab({ scene, camera, renderer, onFrame }),
    '约束': createConstraintsTab({ scene, camera, renderer, onFrame }),
    '重定向': createRetargetTab({ scene, camera, renderer, onFrame }),
    '动画+IK': createAnimIkTab({ scene, camera, renderer, onFrame }),
  };
  const tabsEl = document.getElementById('tabs')!;
  let active: TabHandle | null = null;
  for (const [name, tab] of Object.entries(tabs)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.onclick = () => {
      tabsEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      active?.unmount();
      active = tab;
      tab.mount();
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
