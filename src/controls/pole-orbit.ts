import { Camera, Mesh, MeshBasicMaterial, Object3D, Plane, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import type { DragControl, DragDom, DragPointerEvent } from './drag-target';

// 与 DragTarget/RotateRings 同款命中容差：按相机距离换算的世界容差，让小球在屏幕上可点
const HIT_TOLERANCE_PER_METER = 0.011;

const _axis = new Vector3();   // 链轴（根骨→端球，世界系单位向量）
const _center = new Vector3(); // 轨道中心 = 中骨关节世界位置
const _hit = new Vector3();
const _w = new Vector3();
const _ndc = new Vector2();
const _plane = new Plane();
const _ray = new Raycaster();
const _q = new Quaternion(); // 父世界四元数的逆（世界方向 → 父局部）

/**
 * pole 转向操纵器（轨道球）：球以固定半径待在「中骨关节为心、⊥「根骨→端球」链轴」的
 * 轨道圆上——这个圆就是肘/膝真实能转的轨迹（弯度不变时中骨关节绕链轴的圆）。
 * 拖球 = 球沿轨道滑（离轨道的拖动被吸回轨道面），肘/膝随球转向；球的位置完全由
 * 「轨道中心 + 链轴 + 轨道上方向」逐帧推出，身体移动时自动跟随，无需携带偏移。
 * 纯位置控制点：不参与 W/E 操纵器模式切换，两种模式都常驻可用。
 * 暴露的 ball 即 TwoBoneIK 的 poleTarget（求解器只读其世界位置）。
 *
 * 轨道上方向（世界系）只在拖球/方向提示时改写，绝不把逐帧投影残差写回——写回会让
 * 链轴扫过方向附近时的小残差归一化成任意垂直方向并累积（随机游走），手臂大幅挥动后
 * 方向漂到链轴错误一侧（手横到胸前时肘翻到身前，「反肘」）。逐帧落位只做投影不重写；
 * 投影退化（轴≈方向）时用上次落位方向兜底。
 */
export class PoleOrbit extends Object3D {
  /** 轨道上的球（TwoBoneIK poleTarget / 引导线端点都读它） */
  readonly ball: Mesh;
  readonly ballRadius: number;
  private readonly material: MeshBasicMaterial;
  private orbitRadius: number;
  private dragging = false;
  private readonly dom: DragDom;
  private readonly camera: Camera;
  private readonly dragControl?: DragControl;
  private controlLocked = false;
  private readonly onPointerDown: (e: DragPointerEvent) => void;
  private readonly onPointerMove: (e: DragPointerEvent) => void;
  private readonly onPointerUp: () => void;
  // 轨道中心/链轴来源（bind 注入）：中心 = anchor 世界位置；链轴 = axisFrom→axisTo（端球而非端骨——
  // 端球被可达钳制收拢过，与求解器实际摆出的链一致）
  private anchor: Object3D | null = null;
  private axisFrom: Object3D | null = null;
  private axisTo: Object3D | null = null;
  /** 轨道上方向（世界系，持久状态）：只在拖球/方向提示时改写；逐帧落位做投影但不写回（防残差漂移） */
  private readonly dir = new Vector3(0, 0, 1);
  /** 上次实际落位的世界方向：dir 与链轴近乎平行（投影退化）时的兜底，保持落位连续 */
  private readonly placedDir = new Vector3(0, 0, 1);
  private dirHint: Vector3 | null = null; // 首帧前的初始方向来源（spec 位置或默认摆位）
  /** 命中按下时触发（选中机制用；装配器据此选中所属控制点） */
  onPress?: () => void;

  constructor(camera: Camera, dom: DragDom, options: { color?: number; ballRadius?: number; radius?: number; dragControl?: DragControl } = {}) {
    super();
    this.camera = camera;
    this.dom = dom;
    this.dragControl = options.dragControl;
    this.ballRadius = options.ballRadius ?? 0.0225;
    this.orbitRadius = options.radius ?? 0.2;

    this.material = new MeshBasicMaterial({ color: options.color ?? 0xffcc00, depthTest: false, transparent: true, opacity: 0.9 });
    this.ball = new Mesh(new SphereGeometry(this.ballRadius, 20, 14), this.material);
    this.ball.renderOrder = 999;
    this.add(this.ball);

    this.onPointerDown = (e) => {
      if (!this.visible || !this.anchor) return;
      this.setRay(e);
      this.ball.getWorldPosition(_center);
      if (_ray.ray.distanceToPoint(_center) > this.ballRadius + this.camera.position.distanceTo(_center) * HIT_TOLERANCE_PER_METER) return;
      this.onPress?.();
      this.dragging = true;
      this.dom.setPointerCapture(e.pointerId);
      if (this.dragControl) {
        this.dragControl.lock();
        this.controlLocked = true;
      }
    };
    this.onPointerMove = (e) => {
      if (!this.dragging || !this.frame(_center, _axis)) return;
      this.setRay(e);
      _plane.setFromNormalAndCoplanarPoint(_axis, _center);
      if (!_ray.ray.intersectPlane(_plane, _hit)) return;
      // 吸回轨道面：命中点去轴向分量即轨道上方向（链轴几乎 ⊥ 视线时命中很远，方向仍然有效）
      _w.copy(_hit).sub(_center);
      _w.addScaledVector(_axis, -_w.dot(_axis));
      if (_w.lengthSq() < 1e-10) return;
      this.dir.copy(_w.normalize());
      this.place();
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

  /** 绑定轨道中心/链轴来源：anchor = 中骨关节，链轴 = axisFrom（根骨）→ axisTo（端球） */
  bind(anchor: Object3D, axisFrom: Object3D, axisTo: Object3D): void {
    this.anchor = anchor;
    this.axisFrom = axisFrom;
    this.axisTo = axisTo;
  }

  /** 初始方向提示（世界位置，通常是 spec.pole.position）：首帧投影 ⊥ 链轴后作为轨道上方向 */
  setDirectionHint(worldPos: Vector3): void {
    this.dirHint = worldPos.clone();
  }

  /** 编程式设轨道上方向（世界向量，不必 ⊥ 链轴，内部投影）；自动化测试/外部绑定用 */
  setDirection(worldDir: Vector3): void {
    if (!this.frame(_center, _axis)) return;
    _w.copy(worldDir);
    _w.addScaledVector(_axis, -_w.dot(_axis));
    if (_w.lengthSq() < 1e-10) return;
    this.dir.copy(_w.normalize());
    this.place();
  }

  /** 轨道半径 = 球到肘/膝的固定距离（原 poleRadius 语义） */
  setOrbitRadius(r: number): void {
    this.orbitRadius = r;
    this.place();
  }

  /** 每帧调用（求解之后）：轨道中心/链轴跟随，球按持久方向重新落位 */
  update(): void {
    if (this.dirHint && this.frame(_center, _axis)) {
      _w.copy(this.dirHint).sub(_center);
      _w.addScaledVector(_axis, -_w.dot(_axis));
      if (_w.lengthSq() >= 1e-10) this.dir.copy(_w.normalize());
      this.dirHint = null;
    }
    this.place();
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dragging = false;
    this.releaseControl();
    this.ball.geometry.dispose();
    this.material.dispose();
    this.removeFromParent();
  }

  /** 读当前轨道中心/链轴（世界系）；链轴退化（端球压在根骨上）时返回 false，本帧不动 */
  private frame(center: Vector3, axis: Vector3): boolean {
    if (!this.anchor || !this.axisFrom || !this.axisTo) return false;
    this.anchor.getWorldPosition(center);
    this.axisFrom.getWorldPosition(_w);
    this.axisTo.getWorldPosition(axis).sub(_w);
    if (axis.lengthSq() < 1e-10) return false;
    axis.normalize();
    return true;
  }

  /** 按持久状态落位：中心 = 中骨关节，球 = 中心 + 半径 ×（持久方向 ⊥ 链轴的投影）。
   *  投影结果不写回 dir（防小残差归一化后累积漂移）；dir 与链轴近乎平行时用上次落位
   *  方向兜底。本体不旋转，球的世界偏移直接是方向×半径——父带旋转时用父世界四元数的逆换算回局部 */
  private place(): void {
    if (!this.frame(_center, _axis)) return;
    _w.copy(this.dir);
    _w.addScaledVector(_axis, -_w.dot(_axis));
    if (_w.lengthSq() < 1e-6) {
      // 持久方向几乎贴上链轴：用上次的落位方向保持连续（不改写 dir，扫过退化区后自动恢复）
      _w.copy(this.placedDir);
      _w.addScaledVector(_axis, -_w.dot(_axis));
      if (_w.lengthSq() < 1e-10) return;
    }
    _w.normalize();
    this.placedDir.copy(_w);
    if (this.parent) {
      this.position.copy(this.parent.worldToLocal(_center));
      this.parent.getWorldQuaternion(_q).invert();
      this.ball.position.copy(_w).applyQuaternion(_q).multiplyScalar(this.orbitRadius);
    } else {
      this.position.copy(_center);
      this.ball.position.copy(_w).multiplyScalar(this.orbitRadius);
    }
  }

  private setRay(e: DragPointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  private releaseControl(): void {
    if (this.controlLocked && this.dragControl) {
      this.dragControl.unlock();
      this.controlLocked = false;
    }
  }
}
