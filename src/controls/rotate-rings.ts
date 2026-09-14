import { Object3D, Quaternion, Vector3 } from 'three';

/** 旋转环半径的类默认值（manipulatorSize 基准；ControlsDefaults.ringRadius 缺省同值） */
export const DEFAULT_RING_RADIUS = 0.16;

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

const _c = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();
const _dq = new Quaternion();

/** 把 v 包装回 (−π, π]（逐次角度差分，防跨 ±π 跳变） */
function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export interface RotateRingsOptions {
  /** 环半径（仅作 gizmo 尺寸提示——渲染归 TransformControls，本类不再渲染） */
  ringRadius?: number;
  /** 只启用这些轴（0-2 的子集，缺省全 3 轴）：二维操纵器（如肘环）用 → driver 的 showX/Y/Z */
  rings?: number[];
  /** 视角环（TC 'E' 通道）开关，默认 true */
  viewRing?: boolean;
}

/**
 * 旋转朝向 proxy（无头）：渲染与指针交互由 TransformControls 接管（装配器 attach 路由），
 * 本类只保留 IK 语义——
 *  朝向模式（默认）：本对象的世界四元数即「期望的骨骼全局朝向」，CopyTransformModifier
 *    (referenceObject: rings, copyRotation) 据此驱动骨骼。朝向来源两选一——
 *     setOrientationCarry（FK 语义，掰骨控制点标配）：朝向 = 父骨世界朝向 × 局部偏移。
 *       父骨转动时端骨跟着相对转动，不钉绝对世界朝向；局部偏移初始 = 关节静止局部四元数，
 *       外部拖拽（updateExternalDrag）时逐帧重捕；
 *     默认（未设携带）：非拖拽时每帧从关节世界朝向同步（跟随求解结果）。
 *  增量模式（设了 onDragDelta）：TC 转出的自身朝向只作拖拽反馈，不改语义；改为回调
 *   「按下以来的累计角」（驱动外部通道用，如肘环 → 前臂旋转/伸缩）；朝向由 orientationSource
 *    逐帧供给，松手（endExternalDrag）回落。累计角用「逐次 twist 差分累计」而非四元数直解——
 *    直解在 |angle|>π 处回绕，差分累计支持多圈拖拽；同一帧连发多次 objectChange 时
 *    q_cur 恒反映 TC 全量旋转，差分不丢角度。
 */
export class RotateRings extends Object3D {
  readonly ringRadius: number;
  /** 启用轴掩码（[X, Y, Z]）→ driver attach 的 showX/Y/Z */
  readonly axisMask: [boolean, boolean, boolean];
  /** 视角环（E）开关 → driver attach 的 viewRing */
  readonly viewRing: boolean;
  private joint: Object3D | null = null;
  // 朝向携带：carryParent 世界朝向 × localOffset = proxy 朝向；localOffset 只在设携带/外部拖拽时改写
  private carryParent: Object3D | null = null;
  private readonly localOffset = new Quaternion();
  private dragging = false;
  // 外部拖拽状态：按下快照 + 冻结拖轴 + 逐次累计角
  private dragAxisIndex = -1;
  private readonly prevQuat = new Quaternion();
  private readonly dragAxisWorld = new Vector3();
  private totalDelta = 0;

  /** 增量模式：外部拖拽回调「按下以来的累计角」（axisIndex：0-2；axisWorld 为冻结拖轴，只读勿持有） */
  onDragDelta?: (axisIndex: number, totalAngle: number, axisWorld: Vector3) => void;
  /** 外部拖拽开始（kinds 在此捕获快照——等价旧 onPress 的快照职责；选中上报已由球/标记承担） */
  onDragStart?: (axisIndex: number, axisWorld: Vector3) => void;
  onDragEnd?: () => void;
  /** 增量模式的朝向源：非拖拽时每帧调用，返回值即 proxy 的世界朝向（如按当前姿势计算的肘坐标架） */
  orientationSource?: (out: Quaternion) => void;

  constructor(options: RotateRingsOptions = {}) {
    super();
    this.ringRadius = options.ringRadius ?? DEFAULT_RING_RADIUS;
    const rings = options.rings ?? [0, 1, 2];
    this.axisMask = [rings.includes(0), rings.includes(1), rings.includes(2)];
    this.viewRing = options.viewRing ?? true;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** gizmo 尺寸倍率：相对类默认环半径 */
  get manipulatorSize(): number {
    return this.ringRadius / DEFAULT_RING_RADIUS;
  }

  /** 跟随的关节骨：每帧 update 把 proxy 搬到关节世界位置 */
  setJoint(joint: Object3D): void {
    this.joint = joint;
  }

  /** 朝向携带（FK 语义）：proxy 朝向 = parent 世界朝向 × 局部偏移，父骨转动时端骨相对跟随。
   *  局部偏移取调用瞬间的关节局部四元数（装配期 = rest）；调用即把 proxy 摆到关节当前朝向，
   *  保证装配首解（rig.update(0) 先于首次 update()）CopyTransform 拿到的就是正确朝向 */
  setOrientationCarry(parent: Object3D): void {
    this.carryParent = parent;
    if (!this.joint) return;
    this.localOffset.copy(this.joint.quaternion);
    this.joint.updateWorldMatrix(true, false);
    this.joint.getWorldQuaternion(_q);
    this.writeWorldQuat(_q);
    this.joint.getWorldPosition(_c);
    if (this.parent) this.parent.worldToLocal(_c);
    this.position.copy(_c);
  }

  /** 外部操纵器（TC）拖拽开始。axisIndex：0-2 = 局部轴环；-1 = 视角环 E（仅朝向模式可接受，
   *  增量模式的视角环由 driver 在配置层隐藏，这里防御性忽略） */
  beginExternalDrag(axisIndex: number): void {
    this.dragging = true;
    this.dragAxisIndex = axisIndex;
    this.getWorldQuaternion(this.prevQuat);
    this.totalDelta = 0;
    if (axisIndex < 0) return; // 朝向模式的 E 环：TC 全权改写朝向，无需快照
    this.dragAxisWorld.copy(AXES[axisIndex]!).applyQuaternion(this.prevQuat);
    this.onDragStart?.(axisIndex, this.dragAxisWorld);
  }

  /** TC objectChange 时调用：增量模式提取累计角；朝向模式重捕携带 localOffset */
  updateExternalDrag(): void {
    if (!this.dragging) return;
    if (this.onDragDelta) {
      if (this.dragAxisIndex < 0) return; // 防御：增量模式不认 E/XYZE
      // 逐次 twist 差分累计：dq = q_cur × q_prev⁻¹ 绕冻结拖轴的转角（2·atan2(投影, w)）
      this.getWorldQuaternion(_q);
      _dq.copy(this.prevQuat).invert().premultiply(_q);
      this.prevQuat.copy(_q);
      const a = this.dragAxisWorld;
      const dot = _dq.x * a.x + _dq.y * a.y + _dq.z * a.z;
      this.totalDelta += wrapPi(2 * Math.atan2(dot, _dq.w));
      this.onDragDelta(this.dragAxisIndex, this.totalDelta, a);
      return;
    }
    // 朝向模式：TC 已改写自身朝向；FK 携带重捕局部偏移（父骨朝向拖拽中不变）
    if (this.carryParent) {
      this.getWorldQuaternion(_q);
      this.carryParent.getWorldQuaternion(_pq).invert();
      this.localOffset.copy(_pq.multiply(_q));
    }
  }

  endExternalDrag(): void {
    this.dragging = false;
    this.dragAxisIndex = -1;
    // 增量模式的 proxy 朝向是拖拽的临时产物：松手立即回落朝向源
    if (this.onDragDelta) this.syncOrientation();
    this.onDragEnd?.();
  }

  /** 每帧调用（求解之后）：跟随关节位置；非拖拽时朝向 = 朝向源/携带父骨/关节（按优先级）。
   *  渲染与屏幕恒定大小归 TransformControls gizmo，本类不管 */
  update(): void {
    if (!this.joint) return;
    this.joint.getWorldPosition(_c);
    if (this.parent) this.parent.worldToLocal(_c);
    this.position.copy(_c);
    if (!this.dragging) this.syncOrientation();
  }

  private syncOrientation(): void {
    if (!this.joint) return;
    if (this.orientationSource) {
      this.orientationSource(_q);
      this.writeWorldQuat(_q);
    } else if (this.carryParent) {
      this.carryParent.getWorldQuaternion(_q).multiply(this.localOffset);
      this.writeWorldQuat(_q);
    } else {
      this.joint.getWorldQuaternion(_q);
      this.writeWorldQuat(_q);
    }
  }

  /** 世界四元数 → 父局部写入（挂点即场景顶层时恒等；父有变换时保持世界语义） */
  private writeWorldQuat(worldQ: Quaternion): void {
    if (this.parent) {
      this.parent.getWorldQuaternion(_pq).invert();
      this.quaternion.copy(_pq.multiply(worldQ));
    } else {
      this.quaternion.copy(worldQ);
    }
  }

  /** @deprecated 过渡兼容（attach 路由上线后移除）：显隐不再由本类控制 */
  setVisible(v: boolean): void {
    this.visible = v;
  }

  /** @deprecated 过渡兼容（attach 路由上线后移除）：交互归 TransformControls */
  setInteractive(_v: boolean): void {
    // no-op
  }

  dispose(): void {
    this.dragging = false;
    this.removeFromParent();
  }
}
