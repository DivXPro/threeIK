import { createScene } from './scene';

export interface TabHandle {
  mount(): void;
  unmount(): void;
}

const { scene, camera, renderer, onFrame } = createScene(document.getElementById('app')!);

async function start() {
  // Task 20/21 在此注册页签：const tabs = { 'IK': ikTab(...), ... }
  const tabs: Record<string, TabHandle> = {};
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
  Object.values(tabs)[0]?.mount();
  tabsEl.querySelector('button')?.classList.add('active');
  void scene; void camera; void renderer; void onFrame; // Task 20/21 使用
}

start();
