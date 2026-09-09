import { Camera, MathUtils, Mesh, MeshBasicMaterial, Object3D, Plane, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { AxisArrows, HIT_TOLERANCE_PER_METER, MANIPULATOR_REF_DIST, rayAxisClosest } from './axis-arrows';

export { MANIPULATOR_REF_DIST };

/** 标记球选中高亮色（与操纵器 hover 高亮同色系：亮黄 = 「激活」） */
export const MARKER_SELECTED_COLOR = 0xffee33;

/** 常驻标记球的身份尺寸（相对可拖球的缩放）：纯选中入口比可拖控制点小一号，构建期一次设定 */
export const MARKER_SCALE = 0.7;

// 约束计算模块临时量（applyConstraints 在拖拽热路径上，不逐帧分配）
const _c = new Vector3(); // 锚点世界位置
const _off = new Vector3();
const _ortho = new Vector3();
const _snap = new Vector3(); // snapIntoConstraints 的命中点（与 _c/_off/_ortho 不别名）
const _planeHit = new Vector3(); // moveTo 的拖拽平面命中点

/** 拖球期间禁用视角控制（OrbitControls）的计数锁接口，由应用侧注入（playground scene.ts 同款） */
export interface DragControl {
  lock(): void;
  unlock(): void;
}

/** 指针事件最小结构（PointerEvent 子集）：库本身不依赖 DOM lib，node 测试传桩即可 */
export interface DragPointerEvent {
  clientX: number;
  clientY: number;
  pointerId: number;
}

/** 事件宿主最小结构（HTMLElement 子集，方法签名双变兼容真实元素） */
export interface DragDom {
  addEventListener(type: string, listener: (e: DragPointerEvent) => void): void;
  removeEventListener(type: string, listener: (e: DragPointerEvent) => void): void;
  setPointerCapture(pointerId: number): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/**
 * 可拖拽的 IK target 球：指针拖拽命中、约束钳制（可达球 / 方向锥）、锚点携带。
 * 挂在场景顶层（世界坐标定位）；约束与拖拽均在世界空间计算，写入时换算回父局部。
 */
export class DragTarget extends Object3D {
  readonly ball: Mesh;
  /** 视觉球半径（拖拽命中在此基础上再加按相机距离换算的容差） */
  readonly ballRadius: number;
  private readonly material: MeshBasicMaterial;
  private baseColor: number;
  private dragging = false;
  private readonly dom: DragDom;
  private readonly onPointerDown: (e: DragPointerEvent) => void;
  private readonly onPointerMove: (e: DragPointerEvent) => void;
  private readonly onPointerUp: () => void;
  // 可达范围钳制：拖拽写入时把球限制在以 center 世界位置为球心、radius 为半径的球体内，
  // 防止 target 被拖到链够不着的位置导致视觉脱靶（pole/注视等方向型 target 不要设）
  private reachCenter: Object3D | null = null;
  private reachRadius = 0;
  // 方向锥钳制：球被限制在以 anchor 世界位置为顶点、coneDir 为轴、maxAngle 为半角的锥内，
  // 且与 anchor 的距离收拢到 [coneMinDist, coneMaxDist]——用于方向语义 target（头部注视/膝盖 pole），
  // 防止拖到脑后（头反拧）或关节后方（膝反折）；径向距离本不影响求解，收拢它只是让球不飘走
  private coneAnchor: Object3D | null = null;
  private readonly coneDir = new Vector3();
  private coneCos = 1;
  private coneSin = 0;
  private coneMinDist = 0;
  private coneMaxDist = Infinity;
  private readonly dragControl?: DragControl;
  private controlLocked = false;
  // 操纵器模式切换（move/rotate）用：非交互时 pointerdown 不响应（球本体可由 setVisible 隐藏）
  private interactive = true;
  // 选中机制（Maya 同款：只有选中的控制点才显示操纵器）：
  // onPress = 任意命中按下时上报（装配器据此选中所属控制点）；
  // marker 模式 = 球显示但不可拖（rotate 模式下的可点标记），按下只触发 onPress；
  // selected = 轴箭头显示的前提（arrowsOn && selected && 球可见）
  /** 命中按下时触发（选中机制用）；无论是否进入拖拽都会调 */
  onPress?: () => void;
  private markerMode = false;
  private selected = false;
  private readonly camera: Camera;
  // 跟随锚点：非拖拽时球随锚点（通常是钳制中心骨）世界平移，保持相对偏移——
  // 否则拖其他部位带动锚点（如脊柱弯腰搬动肩膀/脚球搬动膝盖）时，球滞留原地脱离钳制域
  private carryAnchor: Object3D | null = null;
  private readonly carryOffset = new Vector3();
  // 轴箭头（Maya Move 样式移动操纵器，视图/命中抽在 AxisArrows）：拖箭头 = 沿该世界轴单轴移动；
  // 中心球 = 屏幕平面自由拖（默认路径）。箭头随球显隐（setVisible）+ 选中态（setSelected）
  private arrowsOn = false;
  private arrowLen = 0;
  private arrows: AxisArrows | null = null;
  // 轴拖拽状态（按下时冻结锚点与轴；逐事件求射线相对轴线的最近参量，固定锚点防钳制漂移）
  private axisDragging = false;
  private readonly dragAxisVec = new Vector3();
  private readonly dragStartPos = new Vector3();
  private dragAxisT0 = 0;

  constructor(
    camera: Camera,
    dom: DragDom,
    initial: Vector3,
    color = 0xff5533,
    dragControl?: DragControl,
    ballRadius = 0.0225,
  ) {
    super();
    this.dom = dom;
    this.camera = camera;
    this.dragControl = dragControl;
    this.position.copy(initial);
    this.ballRadius = ballRadius;
    this.baseColor = color;
    this.material = new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
    this.ball = new Mesh(new SphereGeometry(ballRadius, 20, 14), this.material);
    this.ball.renderOrder = 999;
    this.add(this.ball);

    const ray = new Raycaster();
    const plane = new Plane();
    const ndc = new Vector2();
    const hit = new Vector3();
    const pick = { t: 0, dist: 0 };

    const setNdc = (e: DragPointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    // 监听器保存为字段引用，dispose 可移除（编辑器多视图/页签切换防泄漏）
    this.onPointerDown = (e: DragPointerEvent) => {
      if (!this.interactive || !this.ball.visible) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      // 容差命中：raycast 缩小版球体容易脱靶（尤其触屏），按相机距离给射线一个世界余量
      this.ball.getWorldPosition(_c);
      const cameraDist = camera.position.distanceTo(_c);
      const tolerance = cameraDist * HIT_TOLERANCE_PER_METER;
      // 轴箭头优先于中心球命中
      const axisT = { t: 0 };
      const best = this.arrows?.pick(ray.ray, _c, cameraDist, axisT) ?? -1;
      if (best >= 0) {
        this.onPress?.();
        if (this.markerMode) return; // 标记模式：按下即选中，不进入拖拽
        this.dragging = true;
        this.axisDragging = true;
        this.arrows!.dragAxisIndex = best;
        this.arrows!.applyColors();
        this.arrows!.axisWorld(best, this.dragAxisVec);
        this.dragAxisT0 = axisT.t;
        this.dragStartPos.copy(this.getWorldPosition(new Vector3()));
        dom.setPointerCapture(e.pointerId);
        if (this.dragControl) {
          this.dragControl.lock();
          this.controlLocked = true;
        }
        return;
      }
      if (ray.ray.distanceToPoint(_c) <= this.ballRadius * this.ball.scale.x + tolerance) {
        this.onPress?.();
        if (this.markerMode) return; // 标记模式：按下即选中，不进入拖拽
        this.dragging = true;
        // 拖拽平面：过当前位置、面向相机
        camera.getWorldDirection(plane.normal);
        plane.setFromNormalAndCoplanarPoint(plane.normal, this.getWorldPosition(new Vector3()));
        dom.setPointerCapture(e.pointerId);
        if (this.dragControl) {
          this.dragControl.lock();
          this.controlLocked = true;
        }
      }
    };
    this.onPointerMove = (e: DragPointerEvent) => {
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (!this.dragging) {
        // hover 高亮：箭头可见时挑出悬停轴，否则清空
        if (this.interactive && this.ball.visible && this.arrows?.visible) {
          this.ball.getWorldPosition(_c);
          const ht = { t: 0 };
          this.arrows.hoverAxis = this.arrows.pick(ray.ray, _c, camera.position.distanceTo(_c), ht);
        } else if (this.arrows) {
          this.arrows.hoverAxis = -1;
        }
        this.arrows?.applyColors();
        return;
      }
      if (this.axisDragging) {
        // 单轴移动：新位置 = 抓取锚点 + 轴 ×（当前参量 − 抓取参量）；锚点固定，钳制不漂移
        if (rayAxisClosest(ray.ray, this.dragAxisVec, this.dragStartPos, pick)) {
          hit.copy(this.dragStartPos).addScaledVector(this.dragAxisVec, pick.t - this.dragAxisT0);
          this.applyDragPoint(hit);
        }
        return;
      }
      if (ray.ray.intersectPlane(plane, hit)) {
        this.applyDragPoint(hit);
      }
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

  /** 是否正被拖拽（pole 双通道/自动动画目标据此判定） */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** 操纵器模式切换：非交互时 pointerdown 不响应 */
  setInteractive(v: boolean): void {
    this.interactive = v;
  }

  /** 显示/隐藏球体（模式切换配套；隐藏即不可命中；轴箭头跟随球与选中态） */
  setVisible(v: boolean): void {
    this.ball.visible = v;
    this.syncArrowsVisibility();
  }

  /** 标记模式（rotate 模式下双通道控制点的球变成可点标记）：显示但不可拖，按下只触发选中。
   *  只切可拖性——球的大小不随模式/选中变化（W/E 切换时控制点大小应保持一致） */
  setMarkerMode(v: boolean): void {
    this.markerMode = v;
    this.syncMarkerAppearance();
  }

  /** 选中态（Maya 同款：只有选中的控制点才显示操纵器）：轴箭头的显示前提之一；
   *  标记模式下的球选中高亮 = 变亮黄（不改大小）——纯旋转控制点点击反馈全靠它 */
  setSelected(v: boolean): void {
    this.selected = v;
    this.syncArrowsVisibility();
    this.syncMarkerAppearance();
  }

  /** 标记球配色：选中 = 亮黄，未选中 = 本色。大小不由这里管——常驻标记的身份尺寸由 kind 构建期定 */
  private syncMarkerAppearance(): void {
    this.material.color.setHex(this.markerMode && this.selected ? MARKER_SELECTED_COLOR : this.baseColor);
  }

  /** 运行期换色（主题切换等）：更新本色。当前处于选中高亮则保持亮黄，
   *  取消选中后落回新本色；大小与可拖性不受影响 */
  setColor(color: number): void {
    this.baseColor = color;
    this.syncMarkerAppearance();
  }

  /** 每帧调用（ctl.update）：轴箭头屏幕恒定大小——按相机距离换算世界缩放 */
  updateFrame(): void {
    if (!this.arrows?.visible) return;
    this.ball.getWorldPosition(_c);
    this.arrows.updateScale(this.camera.position.distanceTo(_c));
  }

  private syncArrowsVisibility(): void {
    this.arrows?.setVisible(this.arrowsOn && this.selected && this.ball.visible);
  }

  /** 开关轴箭头（Maya Move 样式移动操纵器）：拖箭头 = 沿该世界轴单轴移动。
   *  len 缺省 = 8 倍球半径（屏幕恒定大小：参照距离 3.5m 处的世界长度）；箭头资源模块级共享，
   *  重复调用不重复建。箭头只在控制点被选中时显示（setSelected） */
  setAxisHandles(on: boolean, len?: number): void {
    this.arrowsOn = on;
    if (on && !this.arrows) {
      this.arrowLen = len ?? this.ballRadius * 8;
      this.arrows = new AxisArrows(this.arrowLen);
      this.add(this.arrows.group);
    }
    this.syncArrowsVisibility();
  }

  /** 设置可达范围钳制：center 的实时世界位置为球心，radius 为最大距离。
   *  当前位置在球外时立即收回到球面上——构造时摆的初始位置不经过拖拽路径，否则会漏钳 */
  setReachConstraint(center: Object3D, radius: number): void {
    this.reachCenter = center;
    this.reachRadius = radius;
    this.snapIntoConstraints();
  }

  /** 设置方向锥钳制：anchor 世界位置为锥顶，dir 为锥轴（世界方向），maxAngle 为半角（弧度），
   *  距离收拢到 [minDist, maxDist]；min=max 即恒距球面（方向型 target 的"贴身球"用法）。
   *  设置时立即收拢当前位置 */
  setConeConstraint(anchor: Object3D, dir: Vector3, maxAngle: number, minDist: number, maxDist: number): void {
    this.coneAnchor = anchor;
    this.coneDir.copy(dir).normalize();
    this.coneCos = Math.cos(maxAngle);
    this.coneSin = Math.sin(maxAngle);
    this.coneMinDist = minDist;
    this.coneMaxDist = maxDist;
    this.snapIntoConstraints();
  }

  /** 拖拽命中点（世界空间）过约束管线后写入位置；指针拖拽与 moveTo 共用 */
  private applyDragPoint(hit: Vector3): void {
    this.applyConstraints(hit);
    const parent = this.parent;
    if (parent) parent.worldToLocal(hit);
    this.position.copy(hit);
    this.updateCarryOffset(); // 拖拽即改写相对偏移，松手后按新偏移跟随
  }

  /** 编程式移动（外部绑定/自动化测试）：过与指针拖拽相同的约束管线并刷新携带偏移 */
  moveTo(worldPos: Vector3): void {
    this.applyDragPoint(_planeHit.copy(worldPos));
  }

  /** 依次应用可达球与方向锥钳制（就地修改 hit，世界空间） */
  private applyConstraints(hit: Vector3): void {
    if (this.reachCenter) {
      this.reachCenter.getWorldPosition(_c);
      _off.copy(hit).sub(_c);
      if (_off.length() > this.reachRadius) {
        _off.setLength(this.reachRadius);
        hit.copy(_c).add(_off);
      }
    }
    if (this.coneAnchor) {
      this.coneAnchor.getWorldPosition(_c);
      _off.copy(hit).sub(_c);
      const len = MathUtils.clamp(_off.length(), this.coneMinDist, this.coneMaxDist);
      if (_off.lengthSq() < 1e-10) _off.copy(this.coneDir); // 零距离时方向退化，用锥轴兜底
      _off.normalize();
      const d = _off.dot(this.coneDir);
      if (d < this.coneCos) {
        // 出锥：在 dir 与 off 张成的平面内，取与 dir 夹角恰好 maxAngle 的方向
        _ortho.copy(_off).addScaledVector(this.coneDir, -d);
        if (_ortho.lengthSq() < 1e-10) {
          // off 与锥轴反向：任取垂直方向
          _ortho.set(0, 1, 0).cross(this.coneDir);
          if (_ortho.lengthSq() < 1e-10) _ortho.set(1, 0, 0).cross(this.coneDir);
        }
        _ortho.normalize();
        _off.copy(this.coneDir).multiplyScalar(this.coneCos).addScaledVector(_ortho, this.coneSin);
      }
      hit.copy(_c).addScaledVector(_off, len);
    }
  }

  /** 设置跟随锚点：非拖拽时每帧把球携带到「锚点世界位置 + 相对偏移」，偏移在拖拽/收拢后刷新 */
  setCarry(anchor: Object3D): void {
    this.carryAnchor = anchor;
    this.updateCarryOffset();
  }

  /** 每帧调用（求解之后，锚点世界位置已更新）：非拖拽时携带球跟随锚点，并重新过钳制 */
  carryAlong(): void {
    if (!this.carryAnchor || this.dragging) return;
    this.carryAnchor.getWorldPosition(_c);
    _snap.copy(_c).add(this.carryOffset);
    this.applyConstraints(_snap);
    if (this.parent) this.parent.worldToLocal(_snap);
    this.position.copy(_snap);
    this.updateCarryOffset(); // 钳制可能改写了位置，偏移与实际保持一致
  }

  private updateCarryOffset(): void {
    if (!this.carryAnchor) return;
    this.carryAnchor.getWorldPosition(_c);
    this.carryOffset.copy(this.getWorldPosition(_snap).sub(_c));
  }

  /** 设置约束时立即把当前位置收拢进约束域（初始位置不经过拖拽路径） */
  private snapIntoConstraints(): void {
    this.getWorldPosition(_snap);
    this.applyConstraints(_snap);
    if (this.parent) this.parent.worldToLocal(_snap);
    this.position.copy(_snap);
    this.updateCarryOffset(); // 收拢改写了位置，携带偏移与实际保持一致
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.reachCenter = null;
    this.coneAnchor = null;
    this.carryAnchor = null;
    this.dragging = false; // dispose 中途拖拽：状态一并复位，isDragging 不留陈旧 true
    this.axisDragging = false;
    this.arrows?.dispose();
    this.arrows = null;
    this.releaseControl();
  }

  /** dispose 发生在拖拽中途时，也要把视角控制还回去 */
  private releaseControl(): void {
    if (this.controlLocked && this.dragControl) {
      this.dragControl.unlock();
      this.controlLocked = false;
    }
  }
}
