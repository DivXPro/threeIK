import { Camera, Object3D } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { DragControl, DragDom } from './drag-target';
import type { ManipulatorAttachOptions, ManipulatorDriver, ManipulatorMode } from './types';

/** TC rotate gizmo 里体系内没有语义的通道：XYZE = 自由轨球（永久移除） */
const FREE_ROTATE_CHANNEL = 'XYZE';
/** 视角环通道（随 attach 的 viewRing 选项移除/恢复） */
const VIEW_RING_CHANNEL = 'E';

/**
 * TransformControls 适配器：把 three 的 TC 包装成装配器依赖的 ManipulatorDriver 窄接口。
 * 已验证的 TC 内部事实（three r170，r160–r170 事件与 gizmo 命名稳定）——
 *  ① 通道节点（picker/gizmo 视觉/helper 视觉）以轴名命名（'X'/'Y'/'Z'/'E'/'XYZE'），
 *    命中检测 intersectObjectWithRay 尊重 object.visible，但 gizmo 每帧 updateMatrixWorld
 *    会把树内全部 handle 的 visible 重置为 true——所以禁用通道只能 removeFromParent，
 *    不能 visible=false；
 *  ② E（视角环）在 showX/Y/Z 不全 true 时由 TC 自己隐藏，但仍走同一移除/恢复通道处理；
 *  ③ r169 起 TC 是 Controls 基类不再是 Object3D，挂场景用 getHelper()（getHelper shim 兼容旧版）。
 */
export class TransformControlsDriver implements ManipulatorDriver {
  readonly controls: TransformControls;
  private readonly helper: Object3D;
  /** 被移除的通道节点（含原父级，恢复用） */
  private readonly removedChannels = new Map<string, { node: Object3D; parent: Object3D }[]>();
  private readonly dragControl?: DragControl;
  private controlLocked = false;

  onDragStart?: ((info: { axis: string | null }) => void) | null;
  onDragChange?: (() => void) | null;
  onDragEnd?: (() => void) | null;

  constructor(camera: Camera, scene: Object3D, dom: DragDom, dragControl?: DragControl) {
    this.dragControl = dragControl;
    this.controls = new TransformControls(camera, dom as unknown as HTMLElement);
    const withHelper = this.controls as unknown as { getHelper?: () => Object3D };
    // r169+：getHelper() 返回挂场景的 helper；更早版本 TC 本身就是 Object3D
    this.helper = typeof withHelper.getHelper === 'function' ? withHelper.getHelper() : (this.controls as unknown as Object3D);
    scene.add(this.helper);
    this.controls.addEventListener('mouseDown', () => {
      this.onDragStart?.({ axis: this.controls.axis });
    });
    this.controls.addEventListener('objectChange', () => this.onDragChange?.());
    this.controls.addEventListener('mouseUp', () => this.onDragEnd?.());
    this.controls.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value?: boolean }).value === true;
      if (dragging === this.controlLocked) return; // 重复事件不叠加锁
      if (dragging) { this.dragControl?.lock(); this.controlLocked = true; }
      else { this.dragControl?.unlock(); this.controlLocked = false; }
    });
    this.setChannel(FREE_ROTATE_CHANNEL, false);
  }

  get attachedTo(): Object3D | null {
    return (this.controls.object as Object3D | undefined) ?? null;
  }

  setMode(mode: ManipulatorMode): void {
    // 接口说装配器的语言：'move' 映射到 TC 的 'translate'；'rotate' 原样
    this.controls.setMode(mode === 'rotate' ? 'rotate' : 'translate');
    // translate 沿世界轴（旧轴箭头语义）；rotate 绕自身轴（旧环语义：环朝向 = 期望骨骼朝向）
    this.controls.space = mode === 'rotate' ? 'local' : 'world';
  }

  attach(target: Object3D | null, options: ManipulatorAttachOptions = {}): void {
    if (!target) {
      this.controls.detach();
      return;
    }
    this.controls.attach(target);
    this.controls.size = options.size ?? 1;
    const [x, y, z] = options.axes ?? [true, true, true];
    this.controls.showX = x;
    this.controls.showY = y;
    this.controls.showZ = z;
    this.setChannel(VIEW_RING_CHANNEL, options.viewRing ?? true);
  }

  dispose(): void {
    if (this.controlLocked) {
      this.dragControl?.unlock();
      this.controlLocked = false;
    }
    this.controls.dispose();
    this.helper.removeFromParent();
    this.removedChannels.clear();
  }

  /** 按名移除/恢复 helper 子树里的通道节点（picker + gizmo 视觉 + helper 视觉，name 匹配一把抓） */
  private setChannel(name: string, on: boolean): void {
    if (on) {
      const entries = this.removedChannels.get(name);
      if (!entries?.length) return;
      for (const { node, parent } of entries) parent.add(node);
      this.removedChannels.delete(name);
      return;
    }
    const entries: { node: Object3D; parent: Object3D }[] = this.removedChannels.get(name) ?? [];
    this.helper.traverse((o) => {
      if (o.name === name && o.parent && !entries.some((e) => e.node === o)) {
        entries.push({ node: o, parent: o.parent });
      }
    });
    for (const { node } of entries) node.removeFromParent();
    this.removedChannels.set(name, entries);
  }
}
