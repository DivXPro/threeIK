import * as THREE from 'three';

export class DragTarget extends THREE.Object3D {
  readonly ball: THREE.Mesh;

  constructor(camera: THREE.Camera, dom: HTMLElement, initial: THREE.Vector3, color = 0xff5533) {
    super();
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
    let dragging = false;

    const setNdc = (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    dom.addEventListener('pointerdown', (e) => {
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.intersectObject(this.ball, false).length > 0) {
        dragging = true;
        // 拖拽平面：过当前位置、面向相机
        camera.getWorldDirection(plane.normal);
        plane.setFromNormalAndCoplanarPoint(plane.normal, this.getWorldPosition(new THREE.Vector3()));
        dom.setPointerCapture(e.pointerId);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(plane, hit)) {
        const parent = this.parent;
        if (parent) parent.worldToLocal(hit);
        this.position.copy(hit);
      }
    });
    dom.addEventListener('pointerup', () => { dragging = false; });
  }
}
