import { Camera, Mesh, MeshBasicMaterial, Object3D, Plane, Quaternion, Raycaster, TorusGeometry, Vector2, Vector3 } from 'three';
import type { DragControl, DragDom, DragPointerEvent } from './drag-target';

// 与 DragTarget 同款命中容差：按相机距离换算的世界容差，让细环在屏幕上可点
const HIT_TOLERANCE_PER_METER = 0.011;

// 单位环几何共享（mesh.scale 放到实际半径；管粗随之等比）：torus 默认躺在 XY 平面，轴为 +Z
const _unitTorus = new TorusGeometry(1, 0.055, 10, 64);

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const AXIS_COLORS = [0xff5544, 0x44dd66, 0x4488ff]; // X 红 / Y 绿 / Z 蓝
const VIEW_RING_SCALE = 1.3; // 视角环（绕视线轴）比轴环外扩一圈，Maya 外环同款
const VIEW_COLOR = 0xcccccc;

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

/**
 * 旋转操纵器（Maya Rotate Tool 的球系等价物）：三根轴环（绕骨自身 X/Y/Z 轴转）
 * + 一圈面向相机的视角环（绕视线轴转）。数学环命中——射线与环平面求交，
 * 命中点到环心距离落在环半径容差内即命中，不依赖 mesh raycast。
 * 本对象的世界四元数即「期望的骨骼全局朝向」：非拖拽时每帧从关节同步（跟随求解结果），
 * 拖拽时由用户写入；CopyTransformModifier(referenceObject: rings, copyRotation) 据此驱动骨骼。
 */
export class RotateRings extends Object3D {
  readonly ringRadius: number;
  private joint: Object3D | null = null;
  private dragging = false;
  private interactive = true;
  private readonly dom: DragDom;
  private readonly camera: Camera;
  private readonly dragControl?: DragControl;
  private controlLocked = false;
  private readonly onPointerDown: (e: DragPointerEvent) => void;
  private readonly onPointerMove: (e: DragPointerEvent) => void;
  private readonly onPointerUp: () => void;
  private readonly meshes: Mesh[] = [];
  private readonly viewMesh: Mesh;
  private readonly materials: MeshBasicMaterial[] = [];
  // 拖拽状态（按下时冻结：轴/基向量/起始朝向；逐事件角度增量累加）
  private readonly dragAxis = new Vector3();
  private readonly basisU = new Vector3();
  private readonly basisV = new Vector3();
  private readonly startQuat = new Quaternion();
  private lastAngle = 0;
  private totalDelta = 0;

  constructor(camera: Camera, dom: DragDom, options: { ringRadius?: number; dragControl?: DragControl } = {}) {
    super();
    this.camera = camera;
    this.dom = dom;
    this.dragControl = options.dragControl;
    this.ringRadius = options.ringRadius ?? 0.08;

    for (let i = 0; i < 3; i++) {
      const mat = new MeshBasicMaterial({ color: AXIS_COLORS[i], depthTest: false, transparent: true, opacity: 0.9 });
      const mesh = new Mesh(_unitTorus, mat);
      // 环平面 ⊥ 轴向：torus 轴 +Z 旋到 AXES[i]
      if (i === 0) mesh.rotation.y = Math.PI / 2;       // +Z → +X
      else if (i === 1) mesh.rotation.x = -Math.PI / 2; // +Z → +Y
      mesh.scale.setScalar(this.ringRadius);
      mesh.renderOrder = 999;
      this.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(mat);
    }
    const viewMat = new MeshBasicMaterial({ color: VIEW_COLOR, depthTest: false, transparent: true, opacity: 0.6 });
    this.viewMesh = new Mesh(_unitTorus, viewMat);
    this.viewMesh.scale.setScalar(this.ringRadius * VIEW_RING_SCALE);
    this.viewMesh.renderOrder = 998;
    this.add(this.viewMesh); // 朝向每帧由 update 公告板化
    this.materials.push(viewMat);

    this.onPointerDown = (e) => {
      if (!this.interactive || !this.visible) return;
      this.setRay(e);
      const hit = this.pickRing();
      if (!hit) return;
      this.dragging = true;
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
      if (!this.dragging) return;
      this.setRay(e);
      this.getWorldPosition(_c);
      _plane.setFromNormalAndCoplanarPoint(this.dragAxis, _c);
      if (!_ray.ray.intersectPlane(_plane, _p)) return;
      const angle = this.angleOf(_p);
      const delta = wrapPi(angle - this.lastAngle);
      this.totalDelta += delta;
      this.lastAngle = angle;
      // 世界空间：q = axisAngle(轴, 总角) × 起始朝向；写回父局部
      _q.setFromAxisAngle(this.dragAxis, this.totalDelta).multiply(this.startQuat);
      this.writeWorldQuat(_q);
    };
    this.onPointerUp = () => {
      this.dragging = false;
      this.releaseControl();
    };
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** 跟随的关节骨：每帧 update 把环心搬到关节世界位置；非拖拽时朝向同步关节 */
  setJoint(joint: Object3D): void {
    this.joint = joint;
  }

  /** 模式切换用：非交互时 pointerdown 不响应（配合 setVisible 隐藏） */
  setInteractive(v: boolean): void {
    this.interactive = v;
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  /** 每帧调用（求解之后）：跟随关节位置；非拖拽时朝向同步关节；视角环公告板化 */
  update(): void {
    if (this.joint) {
      this.joint.getWorldPosition(_c);
      _parentPos.copy(_c);
      if (this.parent) this.parent.worldToLocal(_parentPos);
      this.position.copy(_parentPos);
      if (!this.dragging) {
        this.joint.getWorldQuaternion(_q);
        this.writeWorldQuat(_q);
      }
    }
    // 视角环面向相机：local = thisWorld⁻¹ × cameraWorld
    this.getWorldQuaternion(_q).invert();
    this.camera.getWorldQuaternion(_pq);
    this.viewMesh.quaternion.copy(_q.multiply(_pq));
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dragging = false;
    this.releaseControl();
    for (const m of this.materials) m.dispose();
    this.removeFromParent();
  }

  private setRay(e: DragPointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  /** 命中检测：返回得分最小（命中点最贴环）的环；无命中返回 null */
  private pickRing(): { axis: Vector3; point: Vector3 } | null {
    this.getWorldPosition(_c);
    this.getWorldQuaternion(_pq);
    const tol = this.camera.position.distanceTo(_c) * HIT_TOLERANCE_PER_METER + this.ringRadius * 0.055;
    let best: { axis: Vector3; point: Vector3; score: number } | null = null;
    for (let i = 0; i < 4; i++) {
      const isView = i === 3;
      if (isView) this.camera.getWorldDirection(_axis);
      else _axis.copy(AXES[i]!).applyQuaternion(_pq);
      const radius = this.ringRadius * (isView ? VIEW_RING_SCALE : 1);
      _plane.setFromNormalAndCoplanarPoint(_axis, _c);
      const p = _ray.ray.intersectPlane(_plane, _p);
      if (!p) continue;
      const score = Math.abs(_w.copy(p).sub(_c).length() - radius);
      if (score <= tol && (!best || score < best.score)) {
        best = { axis: _axis.clone(), point: p.clone(), score };
      }
    }
    return best;
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
