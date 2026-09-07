import { Camera, CylinderGeometry, ConeGeometry, MathUtils, Mesh, MeshBasicMaterial, Object3D, Plane, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';

// 约束计算模块临时量（applyConstraints 在拖拽热路径上，不逐帧分配）
const _c = new Vector3(); // 锚点世界位置
const _off = new Vector3();
const _ortho = new Vector3();
const _snap = new Vector3(); // snapIntoConstraints 的命中点（与 _c/_off/_ortho 不别名）
const _planeHit = new Vector3(); // moveTo 的拖拽平面命中点
// 轴箭头拾取/拖拽临时量
const _ro = new Vector3();
const _w0 = new Vector3();
const _axisW = new Vector3();
const _wq = new Quaternion();

// 拖拽命中间隙：按相机距离换算的世界容差（~26px 屏幕等效），让小球在手机上也能点到
const HIT_TOLERANCE_PER_METER = 0.011;

/** 操纵器屏幕恒定大小的参照距离（米）：相机在这个距离时，箭头/环的世界尺寸 = 设定值；
 *  近了缩小、远了放大，屏幕上看起来永远一样大（Maya 操纵器同款行为） */
export const MANIPULATOR_REF_DIST = 3.5;

// 轴箭头共享资源（模块级单例，不随实例 dispose）：单位箭头沿 +Y，总长约 1，实例按 arrowLen 缩放
const ARROW_COLORS = [0xff5544, 0x44dd66, 0x4488ff]; // X 红 / Y 绿 / Z 蓝
const _shaftGeo = new CylinderGeometry(0.025, 0.025, 0.8, 8).translate(0, 0.4, 0); // 0→0.8
const _tipGeo = new ConeGeometry(0.07, 0.2, 12).translate(0, 0.9, 0);              // 0.8→1.0
const _arrowMats = ARROW_COLORS.map((color) => new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
const _AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

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
  // 轴箭头（Maya Move 样式）：拖箭头 = 沿该世界轴单轴移动；中心球 = 屏幕平面自由拖（默认路径）。
  // 箭头随球显隐（setVisible），根部 1/4 杆长不响应命中（让给中心球）
  private arrowsOn = false;
  private arrowLen = 0;
  private arrowsGroup: Object3D | null = null;
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
    this.ball = new Mesh(
      new SphereGeometry(ballRadius, 20, 14),
      new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
    );
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
    // 射线 vs 轴线的最近参量：t 沿轴（世界单位，可负）、dist 为两线最近距离；
    // 平行或最近点在射线身后返回 false（写入 pick）
    const rayAxisClosest = (axis: Vector3, center: Vector3): boolean => {
      _ro.copy(ray.ray.origin);
      _w0.copy(_ro).sub(center);
      const rd = ray.ray.direction;
      const d = rd.dot(axis);
      const denom = 1 - d * d;
      if (denom < 1e-10) return false;
      const e2 = _w0.dot(rd);
      const f = _w0.dot(axis);
      const t = (f - e2 * d) / denom;
      const s = t * d - e2;
      if (s < 0) return false;
      _off.copy(_w0).addScaledVector(rd, s).addScaledVector(axis, -t); // w0 + s·rd − t·axis
      pick.t = t;
      pick.dist = _off.length();
      return true;
    };
    // 监听器保存为字段引用，dispose 可移除（编辑器多视图/页签切换防泄漏）
    this.onPointerDown = (e: DragPointerEvent) => {
      if (!this.interactive || !this.ball.visible) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      // 容差命中：raycast 缩小版球体容易脱靶（尤其触屏），按相机距离给射线一个世界余量
      this.ball.getWorldPosition(_c);
      const tolerance = camera.position.distanceTo(_c) * HIT_TOLERANCE_PER_METER;
      // 轴箭头优先于中心球命中（根部 1/4 杆长不算——那里是中心球的地盘）
      if (this.arrowsGroup && this.arrowsGroup.visible) {
        this.getWorldQuaternion(_wq);
        let best = -1;
        let bestDist = Infinity;
        let bestT = 0;
        const arrowLenWorld = this.arrowLen * this.arrowsGroup.scale.x; // 屏幕恒定大小：命中区按实际世界长度算
        for (let i = 0; i < 3; i++) {
          _axisW.copy(_AXES[i]!).applyQuaternion(_wq);
          if (!rayAxisClosest(_axisW, _c)) continue;
          if (pick.t < arrowLenWorld * 0.25 || pick.t > arrowLenWorld * 1.15) continue;
          if (pick.dist > tolerance + arrowLenWorld * 0.035) continue;
          if (pick.dist < bestDist) { best = i; bestDist = pick.dist; bestT = pick.t; }
        }
        if (best >= 0) {
          this.onPress?.();
          if (this.markerMode) return; // 标记模式：按下即选中，不进入拖拽
          this.dragging = true;
          this.axisDragging = true;
          this.dragAxisVec.copy(_AXES[best]!).applyQuaternion(_wq);
          this.dragAxisT0 = bestT;
          this.dragStartPos.copy(this.getWorldPosition(new Vector3()));
          dom.setPointerCapture(e.pointerId);
          if (this.dragControl) {
            this.dragControl.lock();
            this.controlLocked = true;
          }
          return;
        }
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
      if (!this.dragging) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (this.axisDragging) {
        // 单轴移动：新位置 = 抓取锚点 + 轴 ×（当前参量 − 抓取参量）；锚点固定，钳制不漂移
        if (rayAxisClosest(this.dragAxisVec, this.dragStartPos)) {
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

  /** 标记模式（rotate 模式下双通道控制点的球变成可点标记）：显示但不可拖，按下只触发选中；
   *  球缩到 0.7 倍与可拖状态区分 */
  setMarkerMode(v: boolean): void {
    this.markerMode = v;
    this.ball.scale.setScalar(v ? 0.7 : 1);
  }

  /** 选中态（Maya 同款：只有选中的控制点才显示操纵器）：轴箭头的显示前提之一 */
  setSelected(v: boolean): void {
    this.selected = v;
    this.syncArrowsVisibility();
  }

  /** 每帧调用（ctl.update）：轴箭头屏幕恒定大小——按相机距离换算世界缩放 */
  updateFrame(): void {
    if (!this.arrowsGroup || !this.arrowsGroup.visible) return;
    this.ball.getWorldPosition(_c);
    this.arrowsGroup.scale.setScalar(this.arrowLen * (this.camera.position.distanceTo(_c) / MANIPULATOR_REF_DIST));
  }

  private syncArrowsVisibility(): void {
    if (this.arrowsGroup) this.arrowsGroup.visible = this.arrowsOn && this.selected && this.ball.visible;
  }

  /** 开关轴箭头（Maya Move 样式移动操纵器）：拖箭头 = 沿该世界轴单轴移动。
   *  len 缺省 = 6 倍球半径（屏幕恒定大小：参照距离 3.5m 处的世界长度）；箭头资源模块级共享，
   *  重复调用不重复建。箭头只在控制点被选中时显示（setSelected） */
  setAxisHandles(on: boolean, len?: number): void {
    this.arrowsOn = on;
    if (on && !this.arrowsGroup) {
      this.arrowLen = len ?? this.ballRadius * 6;
      const g = new Object3D();
      for (let i = 0; i < 3; i++) {
        const arrow = new Object3D();
        const shaft = new Mesh(_shaftGeo, _arrowMats[i]);
        const tip = new Mesh(_tipGeo, _arrowMats[i]);
        shaft.renderOrder = 999;
        tip.renderOrder = 999;
        arrow.add(shaft, tip);
        if (i === 0) arrow.rotation.z = -Math.PI / 2; // 单位箭头 +Y → +X
        else if (i === 2) arrow.rotation.x = Math.PI / 2; // +Y → +Z
        g.add(arrow);
      }
      g.scale.setScalar(this.arrowLen);
      this.arrowsGroup = g;
      this.add(g);
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
