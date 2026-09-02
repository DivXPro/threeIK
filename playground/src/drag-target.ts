import * as THREE from 'three';

export class DragTarget extends THREE.Object3D {
  readonly ball: THREE.Mesh;
  private dragging = false;
  private readonly dom: HTMLElement;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: () => void;

  constructor(camera: THREE.Camera, dom: HTMLElement, initial: THREE.Vector3, color = 0xff5533) {
    super();
    this.dom = dom;
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
      }
    };
    this.onPointerMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(plane, hit)) {
        const parent = this.parent;
        if (parent) parent.worldToLocal(hit);
        this.position.copy(hit);
      }
    };
    this.onPointerUp = () => { this.dragging = false; };
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
  }

  /** 是否正被拖拽（自动动画目标据此暂停轨道运动） */
  get isDragging(): boolean {
    return this.dragging;
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
  }
}
