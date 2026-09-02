import { createScene } from './scene';
import { createIkTab } from './tab-ik';

export interface TabHandle {
  mount(): void;
  unmount(): void;
}

export type PlaygroundContext = ReturnType<typeof createScene>;

const { scene, camera, renderer, onFrame } = createScene(document.getElementById('app')!);

async function start() {
  const tabs: Record<string, TabHandle> = {
    'IK': createIkTab({ scene, camera, renderer, onFrame }),
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
  Object.values(tabs)[0]?.mount();
  tabsEl.querySelector('button')?.classList.add('active');
}

start();
