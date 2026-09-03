import * as THREE from 'three';

// 约束计算模块临时量（applyConstraints 在拖拽热路径上，不逐帧分配）
const _c = new THREE.Vector3(); // 锚点世界位置
const _off = new THREE.Vector3();
const _ortho = new THREE.Vector3();
const _snap = new THREE.Vector3(); // snapIntoConstraints 的命中点（与 _c/_off/_ortho 不别名）
const _planeHit = new THREE.Vector3(); // moveTo 的拖拽平面命中点

// 拖拽命中间隙：按相机距离换算的世界容差（~26px 屏幕等效），
// 让小球在手机上也能点到；视觉球体本身保持 0.0225
const HIT_TOLERANCE_PER_METER = 0.011;

export class DragTarget extends THREE.Object3D {
  readonly ball: THREE.Mesh;
  /** 视觉球半径（拖拽命中在此基础上再加按相机距离换算的容差） */
  readonly ballRadius: number;
  private dragging = false;
  private readonly dom: HTMLElement;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: () => void;
  // 可达范围钳制：拖拽写入时把球限制在以 center 世界位置为球心、radius 为半径的球体内，
  // 防止 target 被拖到链够不着的位置导致视觉脱靶（pole/注视等方向型 target 不要设）
  private reachCenter: THREE.Object3D | null = null;
  private reachRadius = 0;
  // 方向锥钳制：球被限制在以 anchor 世界位置为顶点、coneDir 为轴、maxAngle 为半角的锥内，
  // 且与 anchor 的距离收拢到 [coneMinDist, coneMaxDist]——用于方向语义 target（头部注视/膝盖 pole），
  // 防止拖到脑后（头反拧）或腿后（膝盖反折）；径向距离本不影响求解，收拢它只是让球不飘走
  private coneAnchor: THREE.Object3D | null = null;
  private readonly coneDir = new THREE.Vector3();
  private coneCos = 1;
  private coneSin = 0;
  private coneMinDist = 0;
  private coneMaxDist = Infinity;
  // 拖球期间禁用 OrbitControls（见 scene.ts dragControl），松手/销毁时恢复
  private readonly dragControl?: { lock(): void; unlock(): void };
  private controlLocked = false;
  // 跟随锚点：非拖拽时球随锚点（通常是钳制中心骨）世界平移，保持相对偏移——
  // 否则拖其他部位带动锚点（如脊柱弯腰搬动肩膀/脚球搬动膝盖）时，球滞留原地脱离钳制域
  private carryAnchor: THREE.Object3D | null = null;
  private readonly carryOffset = new THREE.Vector3();

  constructor(
    camera: THREE.Camera,
    dom: HTMLElement,
    initial: THREE.Vector3,
    color = 0xff5533,
    dragControl?: { lock(): void; unlock(): void },
  ) {
    super();
    this.dom = dom;
    this.dragControl = dragControl;
    this.position.copy(initial);
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.0225, 20, 14),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.ball.renderOrder = 999;
    this.ballRadius = 0.0225;
    this.add(this.ball);

    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();

    const setNdc = (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    // 监听器保存为字段引用，dispose 可移除（多页签切换防泄漏）
    this.onPointerDown = (e: PointerEvent) => {
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      // 容差命中：raycast 缩小版球体容易脱靶（尤其触屏），按相机距离给射线一个世界余量
      this.ball.getWorldPosition(_c);
      const tolerance = camera.position.distanceTo(_c) * HIT_TOLERANCE_PER_METER;
      if (ray.ray.distanceToPoint(_c) <= this.ballRadius + tolerance) {
        this.dragging = true;
        // 拖拽平面：过当前位置、面向相机
        camera.getWorldDirection(plane.normal);
        plane.setFromNormalAndCoplanarPoint(plane.normal, this.getWorldPosition(new THREE.Vector3()));
        dom.setPointerCapture(e.pointerId);
        if (this.dragControl) {
          this.dragControl.lock();
          this.controlLocked = true;
        }
      }
    };
    this.onPointerMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(plane, hit)) {
        this.applyDragPoint(hit);
      }
    };
    this.onPointerUp = () => {
      this.dragging = false;
      this.releaseControl();
    };
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
  }

  /** 是否正被拖拽（自动动画目标据此暂停轨道运动） */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** 设置可达范围钳制：center 的实时世界位置为球心，radius 为最大距离。
   *  当前位置在球外时立即收回到球面上——构造时摆的初始位置不经过拖拽路径，否则会漏钳 */
  setReachConstraint(center: THREE.Object3D, radius: number): void {
    this.reachCenter = center;
    this.reachRadius = radius;
    this.snapIntoConstraints();
  }

  /** 设置方向锥钳制：anchor 世界位置为锥顶，dir 为锥轴（世界方向），maxAngle 为半角（弧度），
   *  距离收拢到 [minDist, maxDist]。设置时立即收拢当前位置 */
  setConeConstraint(anchor: THREE.Object3D, dir: THREE.Vector3, maxAngle: number, minDist: number, maxDist: number): void {
    this.coneAnchor = anchor;
    this.coneDir.copy(dir).normalize();
    this.coneCos = Math.cos(maxAngle);
    this.coneSin = Math.sin(maxAngle);
    this.coneMinDist = minDist;
    this.coneMaxDist = maxDist;
    this.snapIntoConstraints();
  }

  /** 拖拽命中点（世界空间）过约束管线后写入位置；指针拖拽与 moveTo 共用 */
  private applyDragPoint(hit: THREE.Vector3): void {
    this.applyConstraints(hit);
    const parent = this.parent;
    if (parent) parent.worldToLocal(hit);
    this.position.copy(hit);
    this.updateCarryOffset(); // 拖拽即改写相对偏移，松手后按新偏移跟随
  }

  /** 编程式移动（Theatre 绑定/自动化测试）：过与指针拖拽相同的约束管线并刷新携带偏移 */
  moveTo(worldPos: THREE.Vector3): void {
    this.applyDragPoint(_planeHit.copy(worldPos));
  }

  /** 依次应用可达球与方向锥钳制（就地修改 hit，世界空间） */
  private applyConstraints(hit: THREE.Vector3): void {
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
      const len = THREE.MathUtils.clamp(_off.length(), this.coneMinDist, this.coneMaxDist);
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
  setCarry(anchor: THREE.Object3D): void {
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
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.reachCenter = null;
    this.coneAnchor = null;
    this.carryAnchor = null;
    this.releaseControl();
  }

  /** 页签切换等 dispose 发生在拖拽中途时，也要把 OrbitControls 还回去 */
  private releaseControl(): void {
    if (this.controlLocked && this.dragControl) {
      this.dragControl.unlock();
      this.controlLocked = false;
    }
  }
}
