import { PerspectiveCamera, type Object3D } from 'three';
import type { DragDom, DragPointerEvent } from '../../src/controls/drag-target';
import type { ManipulatorAttachOptions, ManipulatorDriver } from '../../src/controls/types';

/** DragDom 桩：记录监听器，可编程派发指针事件（默认指向 800×600 视口中心） */
export function makeDomStub() {
  const listeners = new Map<string, Array<(e: DragPointerEvent) => void>>();
  // TC（TransformControls）connect/拖拽路径需要的额外成员；DragDom 结构不变，仅测试桩补齐
  const stub: DragDom & {
    fire(type: string, e: Partial<DragPointerEvent>): void;
    listenerCount(type: string): number;
    style: Record<string, string>;
    ownerDocument: { pointerLockElement: unknown };
    releasePointerCapture(pointerId: number): void;
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
    // 以下三项 TransformControls 需要：connect 写 style.touchAction、拖拽路径读
    // ownerDocument.pointerLockElement、pointerup 调 releasePointerCapture
    style: {} as Record<string, string>,
    ownerDocument: { pointerLockElement: null },
    releasePointerCapture() {},
    fire(type, e) {
      for (const fn of listeners.get(type) ?? []) fn({ clientX: 400, clientY: 300, pointerId: 1, ...e });
    },
    listenerCount: (type) => listeners.get(type)?.length ?? 0,
  };
  return stub;
}

/** ManipulatorDriver fake：记录 setMode/attach，可编程派发拖拽事件（等价 TC 行为由用例
 *  自己写对象变换：fireDragStart → 改写对象 → fireDragChange → fireDragEnd） */
export function makeFakeDriver() {
  const driver = {
    mode: null as 'move' | 'rotate' | null,
    attachedTo: null as Object3D | null,
    attachOptions: undefined as ManipulatorAttachOptions | undefined,
    onDragStart: null as ((info: { axis: string | null }) => void) | null,
    onDragChange: null as (() => void) | null,
    onDragEnd: null as (() => void) | null,
    setMode(m: 'move' | 'rotate') { this.mode = m; },
    attach(t: Object3D | null, options?: ManipulatorAttachOptions) {
      this.attachedTo = t;
      this.attachOptions = options;
    },
    dispose() {},
    fireDragStart(axis: string | null) { this.onDragStart?.({ axis }); },
    fireDragChange() { this.onDragChange?.(); },
    fireDragEnd() { this.onDragEnd?.(); },
  };
  return driver as ManipulatorDriver & typeof driver;
}

/** 默认相机在 (0,0,5) 朝 -Z 看原点：世界原点对应屏幕中心 (400,300) */
export function makeCamera(px = 0, py = 0, pz = 5, lx = 0, ly = 0, lz = 0) {
  const camera = new PerspectiveCamera(45, 800 / 600, 0.01, 100);
  camera.position.set(px, py, pz);
  camera.lookAt(lx, ly, lz);
  camera.updateMatrixWorld(true);
  return camera;
}
