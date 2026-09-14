import { Camera, Color, Mesh, MeshBasicMaterial, Object3D, Plane, Quaternion, Raycaster, TorusGeometry, Vector2, Vector3 } from 'three';
import type { DragControl, DragDom, DragPointerEvent } from './drag-target';

// Task 3 重写时随渲染代码一并删除：屏幕恒定大小的参照距离（原抽自 axis-arrows，该模块已拔除）
const MANIPULATOR_REF_DIST = 3.5;

// 与 DragTarget 同款命中容差：按相机距离换算的世界容差，让细环在屏幕上可点
const HIT_TOLERANCE_PER_METER = 0.011;

// 单位环几何共享（mesh.scale 放到实际半径；管粗随之等比）：torus 默认躺在 XY 平面，轴为 +Z
const RING_TUBE = 0.02; // 管粗（相对环半径）：细线风格，命中容差同步吃这个值
const _unitTorus = new TorusGeometry(1, RING_TUBE, 10, 64);

/** 背向屏幕的半环混入的灰色（偏白的浅灰；保留 20% 本色：红环后半偏粉、高亮后半偏暖） */
const BACK_HALF_COLOR = 0xb0b0b0;

/**
 * 后半环染灰的 shader 补丁（onBeforeCompile，MeshBasicMaterial 标准扩展点）：
 * 比环心离相机更远的片段 = 背向屏幕的一半，混成灰调——深度线索（Maya/Blender 操纵器同款），
 * 分界线恒为「过环心 ⊥ 视线」的平面，相机转动自动跟随（uCenterViewZ 每帧由 update 刷新）。
 * 模块级函数：所有环材质的 onBeforeCompile 源码相同 → 共享同一个编译产物（program cache key 一致）
 */
function patchBackHalfGray(mat: MeshBasicMaterial, uniforms: { uCenterViewZ: { value: number }; uBackColor: { value: Color } }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCenterViewZ = uniforms.uCenterViewZ;
    shader.uniforms.uBackColor = uniforms.uBackColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vViewZ;')
      // project_vertex 之后 mvPosition = 视图空间位置；相机朝 -Z 看，-z 即离相机距离
      .replace('#include <project_vertex>', '#include <project_vertex>\nvViewZ = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vViewZ;\nuniform float uCenterViewZ;\nuniform vec3 uBackColor;')
      // color_fragment 之后 diffuseColor = 材质本色；越过环心深度 → 灰调（留 20% 本色）
      .replace('#include <color_fragment>', `#include <color_fragment>
	float backHalf = smoothstep(uCenterViewZ - 0.002, uCenterViewZ + 0.002, vViewZ);
	diffuseColor.rgb = mix(diffuseColor.rgb, mix(uBackColor, diffuseColor.rgb, 0.2), backHalf);`);
  };
}

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const AXIS_COLORS = [0xff5544, 0x44dd66, 0x4488ff]; // X 红 / Y 绿 / Z 蓝
const VIEW_RING_SCALE = 1.3; // 视角环（绕视线轴）比轴环外扩一圈，Maya 外环同款
const VIEW_COLOR = 0xcccccc;
const RING_HIGHLIGHT_COLOR = 0xffee33; // hover/拖拽中的环高亮色（Maya 同款黄）

const _c = new Vector3();   // 环心世界位置
const _p = new Vector3();   // 射线∩环平面命中点
const _w = new Vector3();   // 命中点相对环心
const _axis = new Vector3();
const _parentPos = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();
const _ndc = new Vector2();
const _plane = new Plane();
const _ray = new Raycaster();

/** 把 v 包装回 (−π, π]（逐事件角度增量，防跨 ±π 跳变） */
function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export interface RotateRingsOptions {
  ringRadius?: number;
  dragControl?: DragControl;
  /** 只启用这些轴环（0-2 的子集，缺省全 3 根）：二维操纵器（如肘环）用 */
  rings?: number[];
  /** 视角环（绕视线轴的第 4 通道）开关，默认 true */
  viewRing?: boolean;
}

/**
 * 旋转操纵器（Maya Rotate Tool 的球系等价物）：轴环（绕自身 X/Y/Z 轴转，可子集化）
 * + 可选一圈面向相机的视角环（绕视线轴转）。数学环命中——射线与环平面求交，
 * 命中点到环心距离落在环半径容差内即命中，不依赖 mesh raycast。
 * hover/拖拽中的环高亮变黄（Maya 同款；材质实例级，互不影响）。
 * 输出两种模式——
 *  朝向模式（默认）：本对象的世界四元数即「期望的骨骼全局朝向」，CopyTransformModifier
 *    (referenceObject: rings, copyRotation) 据此驱动骨骼。朝向来源两选一——
 *     setOrientationCarry（FK 语义，掰骨控制点标配）：朝向 = 父骨世界朝向 × 局部偏移。
 *       父骨转动时端骨跟着相对转动，不钉绝对世界朝向；局部偏移初始 = 关节静止局部四元数，
 *       用户拖环时逐帧重捕；
 *     默认（未设携带）：非拖拽时每帧从关节世界朝向同步（跟随求解结果）。
 *  增量模式（设了 onRotateDrag）：拖环不改写自身朝向，改为回调「按下以来的累计角」
 *    （驱动外部通道用，如肘环 → 前臂旋转/伸缩）；朝向由 orientationSource 逐帧供给。
 *    累计角而非逐事件增量：同一帧内连发多个 pointermove 时求解器尚未跑、骨骼位置还是
 *    拖拽前的，逐事件增量 × 陈旧骨骼会丢旋转（净剩最后一笔）；累计角 × 拖前快照恒正确。
 */
export class RotateRings extends Object3D {
  readonly ringRadius: number;
  private joint: Object3D | null = null;
  // 朝向携带：carryParent 世界朝向 × localOffset = 环朝向；localOffset 只在设携带/拖环时改写
  private carryParent: Object3D | null = null;
  private readonly localOffset = new Quaternion();
  private dragging = false;
  private hoverRing = -1;     // 指针悬停的环槽位（0..n-1 轴环槽，viewSlot 视角环；-1 无）
  private dragRingIndex = -1; // 拖拽中的环槽位
  private interactive = true;
  private readonly dom: DragDom;
  private readonly camera: Camera;
  private readonly dragControl?: DragControl;
  private controlLocked = false;
  private readonly onPointerDown: (e: DragPointerEvent) => void;
  private readonly onPointerMove: (e: DragPointerEvent) => void;
  private readonly onPointerUp: () => void;
  private readonly meshes: Mesh[] = [];
  private readonly viewMesh: Mesh | null = null;
  private readonly materials: MeshBasicMaterial[] = [];
  /** 后半环染灰的共享 uniform（uCenterViewZ 每帧 update 刷新 = 环心离相机距离；调/测可读） */
  readonly depthUniforms: { uCenterViewZ: { value: number }; uBackColor: { value: Color } } = {
    uCenterViewZ: { value: 0 },
    uBackColor: { value: new Color(BACK_HALF_COLOR) },
  };
  /** 槽位 → 轴序号（0-2）：启用的轴环子集；视角环槽 = ringAxisIndices.length（无视角环则 -1） */
  private readonly ringAxisIndices: number[];
  private readonly viewSlot: number = -1;
  // 拖拽状态（按下时冻结：轴/基向量/起始朝向；逐事件角度增量累加）
  private readonly dragAxis = new Vector3();
  private readonly basisU = new Vector3();
  private readonly basisV = new Vector3();
  private readonly startQuat = new Quaternion();
  private lastAngle = 0;
  private totalDelta = 0;
  /** 命中按下时触发（选中机制用；装配器据此选中所属控制点） */
  onPress?: () => void;
  /** 增量模式：拖环回调「按下以来的累计角」（axisIndex：0-2 轴环、3 视角环；axisWorld 为冻结拖轴，
   *  只读勿持有）。设置后拖环不再改写自身朝向。用累计角 × 拖前快照驱动外部通道——
   *  同一帧连发多个 move、求解器还没跑时用逐事件增量会丢旋转 */
  onRotateDrag?: (axisIndex: number, totalAngle: number, axisWorld: Vector3) => void;
  /** 增量模式的朝向源：非拖拽时每帧调用，返回值即环的世界朝向（如按当前姿势计算的肘坐标架） */
  orientationSource?: (out: Quaternion) => void;

  constructor(camera: Camera, dom: DragDom, options: RotateRingsOptions = {}) {
    super();
    this.camera = camera;
    this.dom = dom;
    this.dragControl = options.dragControl;
    this.ringRadius = options.ringRadius ?? 0.16;
    this.ringAxisIndices = options.rings ?? [0, 1, 2];

    for (const axisIndex of this.ringAxisIndices) {
      const mat = new MeshBasicMaterial({ color: AXIS_COLORS[axisIndex], depthTest: false, transparent: true, opacity: 0.9 });
      patchBackHalfGray(mat, this.depthUniforms);
      const mesh = new Mesh(_unitTorus, mat);
      // 环平面 ⊥ 轴向：torus 轴 +Z 旋到 AXES[axisIndex]
      if (axisIndex === 0) mesh.rotation.y = Math.PI / 2;       // +Z → +X
      else if (axisIndex === 1) mesh.rotation.x = -Math.PI / 2; // +Z → +Y
      mesh.scale.setScalar(this.ringRadius);
      mesh.renderOrder = 999;
      this.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(mat);
    }
    if (options.viewRing ?? true) {
      const viewMat = new MeshBasicMaterial({ color: VIEW_COLOR, depthTest: false, transparent: true, opacity: 0.6 });
      patchBackHalfGray(viewMat, this.depthUniforms);
      this.viewMesh = new Mesh(_unitTorus, viewMat);
      this.viewMesh.scale.setScalar(this.ringRadius * VIEW_RING_SCALE);
      this.viewMesh.renderOrder = 998;
      this.add(this.viewMesh); // 朝向每帧由 update 公告板化
      this.materials.push(viewMat);
      this.viewSlot = this.ringAxisIndices.length;
    }

    this.onPointerDown = (e) => {
      if (!this.interactive || !this.visible) return;
      this.setRay(e);
      const hit = this.pickRing();
      if (!hit) return;
      this.onPress?.();
      this.dragging = true;
      this.dragRingIndex = hit.slot;
      this.applyRingColors();
      this.dragAxis.copy(hit.axis);
      // 右手系角度基：v = axis×u，atan2(w·v, w·u) 即绕轴正方向角
      const ref = Math.abs(hit.axis.y) < 0.9 ? _w.set(0, 1, 0) : _w.set(1, 0, 0);
      this.basisU.crossVectors(hit.axis, ref).normalize();
      this.basisV.crossVectors(hit.axis, this.basisU);
      this.lastAngle = this.angleOf(hit.point);
      this.totalDelta = 0;
      this.getWorldQuaternion(this.startQuat);
      this.dom.setPointerCapture(e.pointerId);
      if (this.dragControl) {
        this.dragControl.lock();
        this.controlLocked = true;
      }
    };
    this.onPointerMove = (e) => {
      if (!this.dragging) {
        // hover 高亮：可交互且可见时挑出悬停环，否则清空
        if (this.interactive && this.visible) {
          this.setRay(e);
          const hit = this.pickRing();
          this.hoverRing = hit ? hit.slot : -1;
        } else {
          this.hoverRing = -1;
        }
        this.applyRingColors();
        return;
      }
      this.setRay(e);
      this.getWorldPosition(_c);
      _plane.setFromNormalAndCoplanarPoint(this.dragAxis, _c);
      if (!_ray.ray.intersectPlane(_plane, _p)) return;
      const angle = this.angleOf(_p);
      const delta = wrapPi(angle - this.lastAngle);
      this.totalDelta += delta;
      this.lastAngle = angle;
      if (this.onRotateDrag) {
        // 增量模式：不改写自身朝向，把「按下以来的累计角」交给外部通道
        const axisIndex = this.dragRingIndex === this.viewSlot ? 3 : this.ringAxisIndices[this.dragRingIndex]!;
        this.onRotateDrag(axisIndex, this.totalDelta, this.dragAxis);
        return;
      }
      // 世界空间：q = axisAngle(轴, 总角) × 起始朝向；写回父局部
      _q.setFromAxisAngle(this.dragAxis, this.totalDelta).multiply(this.startQuat);
      this.writeWorldQuat(_q);
      // 朝向携带：拖环即重捕局部偏移（父骨朝向当前不变，offset = parent⁻¹ × rings）
      if (this.carryParent) {
        this.carryParent.getWorldQuaternion(_pq).invert();
        this.localOffset.copy(_pq.multiply(_q));
      }
    };
    this.onPointerUp = () => {
      this.dragging = false;
      this.dragRingIndex = -1;
      this.hoverRing = -1; // 下一次 pointermove 重算
      this.applyRingColors();
      this.releaseControl();
    };
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** 跟随的关节骨：每帧 update 把环心搬到关节世界位置 */
  setJoint(joint: Object3D): void {
    this.joint = joint;
  }

  /** 朝向携带（FK 语义）：环朝向 = parent 世界朝向 × 局部偏移，父骨转动时端骨相对跟随。
   *  局部偏移取调用瞬间的关节局部四元数（装配期 = rest）；调用即把环摆到关节当前朝向，
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

  /** 模式切换用：非交互时 pointerdown 不响应（配合 setVisible 隐藏） */
  setInteractive(v: boolean): void {
    this.interactive = v;
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  /** 每帧调用（求解之后）：跟随关节位置；非拖拽时朝向 = 朝向源/携带父骨/关节（按优先级）；
   *  视角环公告板化；屏幕恒定大小（Maya 操纵器同款）：按相机距离缩放，ringRadius 是参照距离 3.5m 处的世界半径 */
  update(): void {
    if (this.joint) {
      this.joint.getWorldPosition(_c);
      _parentPos.copy(_c);
      if (this.parent) this.parent.worldToLocal(_parentPos);
      this.position.copy(_parentPos);
      if (!this.dragging) {
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
    }
    this.getWorldPosition(_c);
    this.scale.setScalar(this.camera.position.distanceTo(_c) / MANIPULATOR_REF_DIST);
    // 后半环染灰的分界深度 = 环心离相机距离（视图空间 -z）；可能滞后一帧（相机本帧的移动
    // 在渲染时才写 matrixWorldInverse），视觉上不可感知
    _p.copy(_c).applyMatrix4(this.camera.matrixWorldInverse);
    this.depthUniforms.uCenterViewZ.value = -_p.z;
    // 视角环面向相机：local = thisWorld⁻¹ × cameraWorld
    if (this.viewMesh) {
      this.getWorldQuaternion(_q).invert();
      this.camera.getWorldQuaternion(_pq);
      this.viewMesh.quaternion.copy(_q.multiply(_pq));
    }
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dragging = false;
    this.dragRingIndex = -1;
    this.hoverRing = -1;
    this.releaseControl();
    for (const m of this.materials) m.dispose();
    this.removeFromParent();
  }

  private setRay(e: DragPointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  /** 命中检测：返回得分最小（命中点最贴环）的环；无命中返回 null。slot：轴环槽位或 viewSlot */
  private pickRing(): { axis: Vector3; point: Vector3; slot: number } | null {
    this.getWorldPosition(_c);
    this.getWorldQuaternion(_pq);
    const tol = this.camera.position.distanceTo(_c) * HIT_TOLERANCE_PER_METER + this.ringRadius * this.scale.x * RING_TUBE;
    let best: { axis: Vector3; point: Vector3; slot: number; score: number } | null = null;
    const count = this.ringAxisIndices.length + (this.viewMesh ? 1 : 0);
    for (let slot = 0; slot < count; slot++) {
      const isView = slot === this.viewSlot;
      if (isView) this.camera.getWorldDirection(_axis);
      else _axis.copy(AXES[this.ringAxisIndices[slot]!]!).applyQuaternion(_pq);
      const radius = this.ringRadius * this.scale.x * (isView ? VIEW_RING_SCALE : 1); // 屏幕恒定大小后的实际世界半径
      _plane.setFromNormalAndCoplanarPoint(_axis, _c);
      const p = _ray.ray.intersectPlane(_plane, _p);
      if (!p) continue;
      const score = Math.abs(_w.copy(p).sub(_c).length() - radius);
      if (score <= tol && (!best || score < best.score)) {
        best = { axis: _axis.clone(), point: p.clone(), slot, score };
      }
    }
    return best;
  }

  /** 环配色：拖拽中的环 > 悬停环 > 各色（轴环 X红/Y绿/Z蓝，视角环灰白） */
  private applyRingColors(): void {
    const active = this.dragging ? this.dragRingIndex : this.hoverRing;
    for (let i = 0; i < this.materials.length; i++) {
      const base = i === this.viewSlot ? VIEW_COLOR : AXIS_COLORS[this.ringAxisIndices[i]!]!;
      this.materials[i]!.color.setHex(i === active ? RING_HIGHLIGHT_COLOR : base);
    }
  }

  private angleOf(point: Vector3): number {
    _w.copy(point).sub(this.getWorldPosition(_c));
    return Math.atan2(_w.dot(this.basisV), _w.dot(this.basisU));
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

  private releaseControl(): void {
    if (this.controlLocked && this.dragControl) {
      this.dragControl.unlock();
      this.controlLocked = false;
    }
  }
}
