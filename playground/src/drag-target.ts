import * as THREE from 'three';

export class DragTarget extends THREE.Object3D {
  readonly ball: THREE.Mesh;
  private dragging = false;
  private readonly dom: HTMLElement;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: () => void;
  // 可达范围钳制：拖拽写入时把球限制在以 center 世界位置为球心、radius 为半径的球体内，
  // 防止 target 被拖到链够不着的位置导致视觉脱靶（pole/注视等方向型 target 不要设）
  private reachCenter: THREE.Object3D | null = null;
  private reachRadius = 0;
  // 拖球期间禁用 OrbitControls（见 scene.ts dragControl），松手/销毁时恢复
  private readonly dragControl?: { lock(): void; unlock(): void };
  private controlLocked = false;

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
      new THREE.SphereGeometry(0.045, 20, 14),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.ball.renderOrder = 999;
    this.add(this.ball);

    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const reachCenterWorld = new THREE.Vector3();
    const reachOffset = new THREE.Vector3();

    const setNdc = (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    // 监听器保存为字段引用，dispose 可移除（多页签切换防泄漏）
    this.onPointerDown = (e: PointerEvent) => {
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.intersectObject(this.ball, false).length > 0) {
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
        if (this.reachCenter) {
          this.reachCenter.getWorldPosition(reachCenterWorld);
          reachOffset.copy(hit).sub(reachCenterWorld);
          if (reachOffset.length() > this.reachRadius) {
            reachOffset.setLength(this.reachRadius);
            hit.copy(reachCenterWorld).add(reachOffset);
          }
        }
        const parent = this.parent;
        if (parent) parent.worldToLocal(hit);
        this.position.copy(hit);
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
    const cw = center.getWorldPosition(new THREE.Vector3());
    const off = this.getWorldPosition(new THREE.Vector3()).sub(cw);
    if (off.length() > radius) {
      off.setLength(radius);
      const clamped = cw.add(off);
      if (this.parent) this.parent.worldToLocal(clamped);
      this.position.copy(clamped);
    }
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.reachCenter = null;
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
