import { BufferGeometry, Line, LineBasicMaterial, Object3D, Vector3 } from 'three';

const _gp = new Vector3();
const _gj = new Vector3();

/**
 * pole → 关节引导线：pole 只控制关节绕链轴的朝向（不移动末端），拉线让作用关系可见。
 * 线段端点以世界坐标写入，请把 line 挂在场景顶层（父变换会让世界坐标失真）。
 */
export class PoleGuide {
  readonly line: Line;
  private readonly material: LineBasicMaterial;

  constructor(parent: Object3D, private readonly pole: Object3D, private readonly joint: Object3D, color = 0xaaaaaa) {
    this.material = new LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthTest: false });
    const geo = new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]);
    this.line = new Line(geo, this.material);
    this.line.renderOrder = 998;
    this.line.frustumCulled = false;
    parent.add(this.line);
  }

  /** 每帧调用（求解之后，骨骼世界位置已更新） */
  update(): void {
    this.pole.getWorldPosition(_gp);
    this.joint.getWorldPosition(_gj);
    const pos = this.line.geometry.getAttribute('position');
    pos.setXYZ(0, _gj.x, _gj.y, _gj.z);
    pos.setXYZ(1, _gp.x, _gp.y, _gp.z);
    pos.needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.line.visible = v;
  }

  dispose(): void {
    this.line.removeFromParent();
    this.line.geometry.dispose();
    this.material.dispose();
  }
}
