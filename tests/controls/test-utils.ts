import { PerspectiveCamera } from 'three';
import type { DragDom, DragPointerEvent } from '../../src/controls/drag-target';

/** DragDom 桩：记录监听器，可编程派发指针事件（默认指向 800×600 视口中心） */
export function makeDomStub() {
  const listeners = new Map<string, Array<(e: DragPointerEvent) => void>>();
  const stub: DragDom & {
    fire(type: string, e: Partial<DragPointerEvent>): void;
    listenerCount(type: string): number;
  } = {
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    fire(type, e) {
      for (const fn of listeners.get(type) ?? []) fn({ clientX: 400, clientY: 300, pointerId: 1, ...e });
    },
    listenerCount: (type) => listeners.get(type)?.length ?? 0,
  };
  return stub;
}

/** 默认相机在 (0,0,5) 朝 -Z 看原点：世界原点对应屏幕中心 (400,300) */
export function makeCamera(px = 0, py = 0, pz = 5, lx = 0, ly = 0, lz = 0) {
  const camera = new PerspectiveCamera(45, 800 / 600, 0.01, 100);
  camera.position.set(px, py, pz);
  camera.lookAt(lx, ly, lz);
  camera.updateMatrixWorld(true);
  return camera;
}
