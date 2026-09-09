import { Camera, Mesh, MeshBasicMaterial, Object3D, Plane, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { AxisArrows, HIT_TOLERANCE_PER_METER, rayAxisClosest } from './axis-arrows';
import type { DragControl, DragDom, DragPointerEvent } from './drag-target';

// 球离链轴的最小显示半径：手臂完全伸直时中骨关节钉在轴上（实测半径 0），球仍留 2cm 偏移——
// ① 球不埋进手臂网格、看得见点得着；② poleTarget 的投影方向恒非零，求解器的方向通道不断线
const MIN_POLE_RADIUS = 0.02;

// 径向拖拽死区（米）：纯调朝向的拖动附带亚毫米级半径噪声，小于死区不触发弯度回调（手球不抖）
const RADIUS_DRAG_DEADZONE = 1e-3;

const _axis = new Vector3();   // 链轴（根骨→端球，世界系单位向量）
const _center = new Vector3(); // 环心 = 链轴上离根 axisOffset 的投影点（中骨关节的轴上垂足）
const _hit = new Vector3();
const _w = new Vector3();
const _ndc = new Vector2();
const _plane = new Plane();
const _ray = new Raycaster();
const _q = new Quaternion(); // 父世界四元数的逆（世界方向 → 父局部）
const _pick = { t: 0, dist: 0 };

/**
 * pole 双通道操纵器（肘/膝影子球）：球贴在「中骨关节在 ⊥ 链轴平面上的影子」处——
 * 环心 = 中骨关节的轴上垂足（随姿势逐帧由 setOrbitFrame 推送），球半径 = 关节离轴距离。
 * 拖球两个通道一次手势完成：
 *   角度通道（绕链轴转）= 肘/膝朝向——球在环上的角度即关节绕轴方向（Maya pole vector 同款）；
 *   径向通道（离轴远近）= 弯度——外拽更弯、推回轴心伸直（onRadiusDrag 回调由装配层移动端球实现，
 *   手会跟着动；反过来拖端球仍是 IK，球自动滑回实测半径，兼作弯度仪表）。
 * W 模式（move）操纵器：E 模式退化成可点标记（可见、按下只触发 onPress 选中肘部、不可拖），
 * 换肘部旋转环上场（装配层 onModeChange 换班）——球是肘部在 E 模式唯一的选中入口，不能藏。
 * 暴露的 ball 即 TwoBoneIK 的 poleTarget（求解器只读其世界位置投影出的方向）。
 *
 * 角度方向的持久状态（dir）只在拖球/方向提示时改写，绝不把逐帧投影残差写回——写回会让
 * 链轴扫过方向附近时的小残差归一化成任意垂直方向并累积（随机游走），手臂大幅挥动后
 * 方向漂到链轴错误一侧（手横到胸前时肘翻到身前，「反肘」）。逐帧落位只做投影不重写；
 * 投影退化（轴≈方向）时用上次落位方向兜底。径向则无此问题：空闲时直接同步实测半径。
 */
export class PoleOrbit extends Object3D {
  /** 影子球（TwoBoneIK poleTarget 读它的世界位置） */
  readonly ball: Mesh;
  readonly ballRadius: number;
  private readonly material: MeshBasicMaterial;
  /** 球半径（世界米）：拖拽中 = 用户意图；空闲 = 实测关节离轴距离（setOrbitFrame 推送） */
  private orbitRadius = 0;
  /** 环心在链轴上离根骨的距离（世界米）：逐帧由 setOrbitFrame 推送（拖拽中也更新，跟随弯度变化） */
  private axisOffset = 0;
  private dragging = false;
  // marker 模式（E 模式，与 DragTarget 同款语义）：球显示但不可拖，按下只触发 onPress（选中肘部）——
  // 肘环要选中肘部才上场，球是 E 模式下选中肘部的唯一入口，必须留场可点
  private markerMode = false;
  // 轴箭头（Maya Move 样式，W 模式 + 选中肘部时上场）：拖箭头 = 沿该世界轴单轴挪球，
  // 落回轨道时自然分解为角度（朝向）+ 径向（弯度）两个通道——与自由拖同一套语义
  private arrowsOn = false;
  private selected = false;
  private arrows: AxisArrows | null = null;
  // 轴拖拽状态（按下时冻结抓取点球世界位置与轴；参照架与自由拖共用 dragCenter/dragAxis）
  private axisDragging = false;
  private readonly dragStartBall = new Vector3();
  private readonly dragArrowAxis = new Vector3();
  private dragAxisT0 = 0;
  private lastDragRadius = 0; // 拖拽死区基准（按下时取显示半径）
  // 拖拽期间冻结的参照架（按下瞬间的环心/链轴）：角度通道的命中面 + 径向通道的直线锚点。
  // 不能逐帧跟活架——径向拖动会移动端球改变弯度，环心沿轴滑动、命中面跟着挪，视线贴近
  // 环面（掠射）时命中点沿射线暴走，半径意图自我放大直奔钳制上限（实测 38px 拖动打满弯度）。
  // 拖拽中链轴方向不变（端球只沿轴滑），冻结架的两通道都稳定
  private readonly dragCenter = new Vector3();
  private readonly dragAxis = new Vector3();
  private readonly dom: DragDom;
  private readonly camera: Camera;
  private readonly dragControl?: DragControl;
  private controlLocked = false;
  private readonly onPointerDown: (e: DragPointerEvent) => void;
  private readonly onPointerMove: (e: DragPointerEvent) => void;
  private readonly onPointerUp: () => void;
  // 链轴来源（bind 注入）：axisFrom（根骨）→ axisTo（端球——端球被可达钳制收拢过，与求解器实际摆出的链一致）
  private axisFrom: Object3D | null = null;
  private axisTo: Object3D | null = null;
  /** 环上方向（世界系，持久状态）：只在拖球/方向提示时改写；逐帧落位做投影但不写回（防残差漂移） */
  private readonly dir = new Vector3(0, 0, 1);
  /** 上次实际落位的世界方向：dir 与链轴近乎平行（投影退化）时的兜底，保持落位连续 */
  private readonly placedDir = new Vector3(0, 0, 1);
  private dirHint: Vector3 | null = null; // 首帧前的初始方向来源（spec 位置或默认摆位）
  /** 命中按下时触发（选中机制用；装配器据此认领按下防空白失焦） */
  onPress?: () => void;
  /** 径向通道（弯度）：拖拽中半径意图变化超死区时回调（装配层据此沿链轴移动端球）。
   *  角度通道无需回调——求解器下一帧直接读球的世界位置 */
  onRadiusDrag?: (radius: number) => void;

  constructor(camera: Camera, dom: DragDom, options: { color?: number; ballRadius?: number; dragControl?: DragControl } = {}) {
    super();
    this.camera = camera;
    this.dom = dom;
    this.dragControl = options.dragControl;
    this.ballRadius = options.ballRadius ?? 0.0225;

    this.material = new MeshBasicMaterial({ color: options.color ?? 0xffcc00, depthTest: false, transparent: true, opacity: 0.9 });
    this.ball = new Mesh(new SphereGeometry(this.ballRadius, 20, 14), this.material);
    this.ball.renderOrder = 999;
    this.add(this.ball);

    this.onPointerDown = (e) => {
      if (!this.visible || !this.axisFrom) return;
      this.setRay(e);
      this.ball.getWorldPosition(_center);
      const cameraDist = this.camera.position.distanceTo(_center);
      // 轴箭头优先于中心球命中（marker 模式箭头不上场，天然不命中）
      if (this.arrows?.visible) {
        const at = { t: 0 };
        const best = this.arrows.pick(_ray.ray, _center, cameraDist, at);
        if (best >= 0) {
          this.onPress?.();
          this.dragging = true;
          this.axisDragging = true;
          this.arrows.dragAxisIndex = best;
          this.arrows.applyColors();
          this.arrows.axisWorld(best, this.dragArrowAxis);
          this.dragAxisT0 = at.t;
          this.dragStartBall.copy(_center); // 抓取点 = 球当前世界位置（单轴移动锚点）
          this.lastDragRadius = Math.max(this.orbitRadius, MIN_POLE_RADIUS);
          this.frame(this.dragCenter, this.dragAxis); // 冻结拖拽参照架（与自由拖同款）
          this.dom.setPointerCapture(e.pointerId);
          if (this.dragControl) {
            this.dragControl.lock();
            this.controlLocked = true;
          }
          return;
        }
      }
      if (_ray.ray.distanceToPoint(_center) > this.ballRadius + cameraDist * HIT_TOLERANCE_PER_METER) return;
      this.onPress?.();
      if (this.markerMode) return; // 标记模式：按下即选中，不进入拖拽
      this.dragging = true;
      this.lastDragRadius = Math.max(this.orbitRadius, MIN_POLE_RADIUS); // 死区基准与球的显示位置一致
      if (this.frame(this.dragCenter, this.dragAxis)) { /* 冻结拖拽参照架 */ }
      this.dom.setPointerCapture(e.pointerId);
      if (this.dragControl) {
        this.dragControl.lock();
        this.controlLocked = true;
      }
    };
    this.onPointerMove = (e) => {
      if (!this.dragging) {
        // hover 高亮（仅箭头可见时）
        if (this.arrows?.visible) {
          this.setRay(e);
          this.ball.getWorldPosition(_center);
          const ht = { t: 0 };
          this.arrows.hoverAxis = this.arrows.pick(_ray.ray, _center, this.camera.position.distanceTo(_center), ht);
          this.arrows.applyColors();
        }
        return;
      }
      this.setRay(e);
      if (this.axisDragging) {
        // 单轴挪球：意图位置 = 抓取点 + 轴×(t−t0)，再落回轨道——投影 ⊥ 冻结链轴，
        // 方向写角度通道、模长写径向通道（与自由拖同一套分解，只是输入从平面命中换成轴参量）
        if (rayAxisClosest(_ray.ray, this.dragArrowAxis, this.dragStartBall, _pick)) {
          _w.copy(this.dragStartBall).addScaledVector(this.dragArrowAxis, _pick.t - this.dragAxisT0).sub(this.dragCenter);
          _w.addScaledVector(this.dragAxis, -_w.dot(this.dragAxis));
          if (_w.lengthSq() >= 1e-12) {
            const radius = _w.length();
            this.dir.copy(_w).divideScalar(radius);
            this.orbitRadius = radius;
            if (Math.abs(radius - this.lastDragRadius) > RADIUS_DRAG_DEADZONE) {
              this.lastDragRadius = radius;
              this.onRadiusDrag?.(radius);
            }
          }
          this.place();
        }
        return;
      }
      // 角度通道：冻结架（按下时的环心/链轴）平面命中取方向。不能用逐帧活架——径向拖动
      // 移动端球改变弯度，环心沿轴滑动、命中面跟挪，掠射（视线贴环面）时命中点沿射线
      // 暴走，半径意图自我放大直奔钳制上限（实测 38px 拖动打满弯度）
      _plane.setFromNormalAndCoplanarPoint(this.dragAxis, this.dragCenter);
      if (!_ray.ray.intersectPlane(_plane, _hit)) return;
      _w.copy(_hit).sub(this.dragCenter);
      _w.addScaledVector(this.dragAxis, -_w.dot(this.dragAxis));
      if (_w.lengthSq() >= 1e-12) this.dir.copy(_w.normalize());
      // 径向通道：射线与「过冻结环心、沿当前方向」的径向直线求线-线最近点，参量 t 即半径
      // 意图。平面命中测半径在掠射视角发散；线-线最近点处处有界（射线近乎平行径向线时
      // 本帧跳过——与 Maya 轴约束在顺轴视角失效同款取舍）
      const rd = _ray.ray.direction;
      _w.copy(_ray.ray.origin).sub(this.dragCenter); // w0 = O − C（线-线最近点标准式）
      const b = rd.dot(this.dir);
      const denom = 1 - b * b;
      if (denom > 1e-10) {
        const d = _w.dot(rd);
        const e2 = _w.dot(this.dir);
        const t = (e2 - b * d) / denom; // 径向直线上的参量 = 半径意图
        if (t * b - d > 0) { // 最近点在射线前方才采纳（s = t·b − d）
          const radius = Math.max(0, t);
          this.orbitRadius = radius;
          if (Math.abs(radius - this.lastDragRadius) > RADIUS_DRAG_DEADZONE) {
            this.lastDragRadius = radius;
            this.onRadiusDrag?.(radius);
          }
        }
      }
      this.place();
    };
    this.onPointerUp = () => {
      this.dragging = false;
      this.axisDragging = false;
      if (this.arrows) {
        this.arrows.dragAxisIndex = -1;
        this.arrows.hoverAxis = -1; // 下一次 pointermove 重算
        this.arrows.applyColors();
      }
      this.releaseControl();
    };
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** 绑定链轴来源：axisFrom = 根骨，axisTo = 端球（环心 = 轴上 axisOffset 处，由 setOrbitFrame 推送） */
  bind(axisFrom: Object3D, axisTo: Object3D): void {
    this.axisFrom = axisFrom;
    this.axisTo = axisTo;
  }

  /** 标记模式（E 模式）：球可见可点（onPress 照发，选中肘部用）但不可拖；轴箭头随标记模式收起 */
  setMarkerMode(v: boolean): void {
    this.markerMode = v;
    this.syncArrowsVisibility();
  }

  /** 运行期换色（主题切换等）：pole 球没有选中变色逻辑，立即生效 */
  setColor(color: number): void {
    this.material.color.setHex(color);
  }

  /** 开关轴箭头（Maya Move 样式移动操纵器，与 DragTarget 同款）：拖箭头 = 沿该世界轴单轴挪球，
   *  落回轨道分解为朝向 + 弯度。len 缺省 = 8 倍球半径。箭头只在选中肘部且非标记模式时显示 */
  setAxisHandles(on: boolean, len?: number): void {
    this.arrowsOn = on;
    if (on && !this.arrows) {
      this.arrows = new AxisArrows(len ?? this.ballRadius * 8);
      this.add(this.arrows.group);
    }
    this.syncArrowsVisibility();
  }

  /** 选中态（肘部子选中）：轴箭头的显示前提之一 */
  setSelected(v: boolean): void {
    this.selected = v;
    this.syncArrowsVisibility();
  }

  private syncArrowsVisibility(): void {
    this.arrows?.setVisible(this.arrowsOn && this.selected && !this.markerMode && this.visible);
  }

  /** 逐帧推送轨道几何（装配层按链三角实测）：d = 中骨关节垂足离根骨的轴向距离，r = 关节离轴半径。
   *  拖拽中只更新环心（半径是用户意图，不被实测值覆盖）；空闲时半径同步实测——球即弯度仪表 */
  setOrbitFrame(d: number, r: number): void {
    this.axisOffset = d;
    if (!this.dragging) this.orbitRadius = r;
  }

  /** 初始方向提示（世界位置，通常是 spec.pole.position）：首帧投影 ⊥ 链轴后作为环上方向 */
  setDirectionHint(worldPos: Vector3): void {
    this.dirHint = worldPos.clone();
  }

  /** 编程式设环上方向（世界向量，不必 ⊥ 链轴，内部投影）；自动化测试/外部绑定用 */
  setDirection(worldDir: Vector3): void {
    if (!this.frame(_center, _axis)) return;
    _w.copy(worldDir);
    _w.addScaledVector(_axis, -_w.dot(_axis));
    if (_w.lengthSq() < 1e-10) return;
    this.dir.copy(_w.normalize());
    this.place();
  }

  /** 每帧调用（求解之后）：环心/链轴跟随，球按持久方向与当前半径重新落位 */
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
    this.axisDragging = false;
    this.arrows?.dispose();
    this.arrows = null;
    this.releaseControl();
    this.ball.geometry.dispose();
    this.material.dispose();
    this.removeFromParent();
  }

  /** 读当前环心/链轴（世界系）；链轴退化（端球压在根骨上）时返回 false，本帧不动 */
  private frame(center: Vector3, axis: Vector3): boolean {
    if (!this.axisFrom || !this.axisTo) return false;
    this.axisFrom.getWorldPosition(center);
    this.axisTo.getWorldPosition(axis).sub(center);
    if (axis.lengthSq() < 1e-10) return false;
    axis.normalize();
    center.addScaledVector(axis, this.axisOffset);
    return true;
  }

  /** 按持久状态落位：球 = 环心 + max(半径, MIN_POLE_RADIUS) ×（持久方向 ⊥ 链轴的投影）。
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
    const r = Math.max(this.orbitRadius, MIN_POLE_RADIUS);
    if (this.parent) {
      this.position.copy(this.parent.worldToLocal(_center));
      this.parent.getWorldQuaternion(_q).invert();
      this.ball.position.copy(_w).applyQuaternion(_q).multiplyScalar(r);
    } else {
      this.position.copy(_center);
      this.ball.position.copy(_w).multiplyScalar(r);
    }
    // 箭头跟球走（同一父空间，组自身无旋转 = 世界轴朝向）+ 屏幕恒定大小
    if (this.arrows?.visible) {
      this.arrows.group.position.copy(this.ball.position);
      this.arrows.updateScale(this.camera.position.distanceTo(this.ball.getWorldPosition(_hit)));
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
