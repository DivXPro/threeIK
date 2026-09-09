import { ConeGeometry, CylinderGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Ray, Vector3 } from 'three';

/** 操纵器屏幕恒定大小的参照距离（米）：相机在这个距离时，箭头/环的世界尺寸 = 设定值；
 *  近了缩小、远了放大，屏幕上看起来永远一样大（Maya 操纵器同款行为） */
export const MANIPULATOR_REF_DIST = 3.5;

/** 拖拽命中间隙：按相机距离换算的世界容差（~26px 屏幕等效），让小球/细箭头在手机上也能点到 */
export const HIT_TOLERANCE_PER_METER = 0.011;

const ARROW_COLORS = [0xff5544, 0x44dd66, 0x4488ff]; // X 红 / Y 绿 / Z 蓝
const ARROW_HIGHLIGHT_COLOR = 0xffee33; // hover/拖拽中的轴高亮色（Maya 同款黄）
const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

// 轴箭头共享几何（模块级单例，不随实例 dispose）：单位箭头沿 +Y，总长约 1，实例按 len 缩放
const _shaftGeo = new CylinderGeometry(0.02, 0.02, 0.8, 8).translate(0, 0.4, 0);   // 0→0.8
const _tipGeo = new ConeGeometry(0.095, 0.2, 12).translate(0, 0.9, 0);             // 0.8→1.0

const _ro = new Vector3();
const _w0 = new Vector3();
const _off = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();

/** 射线 vs 轴线的最近参量：t 沿轴（世界单位，可负）、dist 为两线最近距离；
 *  平行或最近点在射线身后返回 false（写入 out） */
export function rayAxisClosest(ray: Ray, axis: Vector3, center: Vector3, out: { t: number; dist: number }): boolean {
  _ro.copy(ray.origin);
  _w0.copy(_ro).sub(center);
  const rd = ray.direction;
  const d = rd.dot(axis);
  const denom = 1 - d * d;
  if (denom < 1e-10) return false;
  const e2 = _w0.dot(rd);
  const f = _w0.dot(axis);
  const t = (f - e2 * d) / denom;
  const s = t * d - e2;
  if (s < 0) return false;
  _off.copy(_w0).addScaledVector(rd, s).addScaledVector(axis, -t); // w0 + s·rd − t·axis
  out.t = t;
  out.dist = _off.length();
  return true;
}

/**
 * 三轴箭头视图（Maya Move 样式）：纯展示 + 命中/配色，不含拖拽状态机——
 * 拖拽语义归宿主（DragTarget 沿轴改位置；PoleOrbit 沿轴挪球再落回轨道）。
 * 箭头挂点的世界朝向即轴朝向（宿主挂场景顶层时 = 世界轴）；根部 1/4 杆长不响应命中（让给中心球）。
 */
export class AxisArrows {
  readonly group = new Object3D();
  /** 参照距离 MANIPULATOR_REF_DIST 处的世界杆长 */
  readonly len: number;
  private readonly mats: MeshBasicMaterial[] = [];
  hoverAxis = -1;     // 指针悬停的轴（-1 无）
  dragAxisIndex = -1; // 拖拽中的轴序号（宿主维护，配色用）

  constructor(len: number) {
    this.len = len;
    // 材质实例级（hover/拖拽高亮要改色，不能用共享材质影响其他宿主）；几何共享
    this.mats = ARROW_COLORS.map((color) => new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    for (let i = 0; i < 3; i++) {
      const arrow = new Object3D();
      const shaft = new Mesh(_shaftGeo, this.mats[i]!);
      const tip = new Mesh(_tipGeo, this.mats[i]!);
      shaft.renderOrder = 999;
      tip.renderOrder = 999;
      arrow.add(shaft, tip);
      if (i === 0) arrow.rotation.z = -Math.PI / 2; // 单位箭头 +Y → +X
      else if (i === 2) arrow.rotation.x = Math.PI / 2; // +Y → +Z
      this.group.add(arrow);
    }
    this.group.visible = false; // 默认不上场：宿主按选中态开关
    this.group.scale.setScalar(len);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** 屏幕恒定大小：按相机距离换算世界缩放（含 len，命中区直接读 group.scale） */
  updateScale(cameraDist: number): void {
    this.group.scale.setScalar(this.len * (cameraDist / MANIPULATOR_REF_DIST));
  }

  /** 命中挑选（射线相对球心 center）：返回最近命中轴序号（-1 无），命中参量写 outT；
   *  根部 1/4 杆长不算（中心球地盘）。命中区长度 = 视觉杆长（updateScale 缩放已含 len，勿再乘） */
  pick(ray: Ray, center: Vector3, cameraDist: number, outT: { t: number }): number {
    if (!this.group.visible) return -1;
    const lenWorld = this.group.scale.x;
    const tolerance = cameraDist * HIT_TOLERANCE_PER_METER;
    const pickOut = { t: 0, dist: 0 };
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < 3; i++) {
      this.axisWorld(i, _axis);
      if (!rayAxisClosest(ray, _axis, center, pickOut)) continue;
      if (pickOut.t < lenWorld * 0.25 || pickOut.t > lenWorld * 1.15) continue;
      if (pickOut.dist > tolerance + lenWorld * 0.02) continue;
      if (pickOut.dist < bestDist) { best = i; bestDist = pickOut.dist; outT.t = pickOut.t; }
    }
    return best;
  }

  /** 轴的世界方向（组自身无旋转时 = 挂点世界朝向 × 基轴） */
  axisWorld(i: number, out: Vector3): Vector3 {
    this.group.getWorldQuaternion(_q);
    return out.copy(AXES[i]!).applyQuaternion(_q);
  }

  /** 配色：拖拽中的轴 > 悬停轴 > 各色 */
  applyColors(): void {
    const active = this.dragAxisIndex >= 0 ? this.dragAxisIndex : this.hoverAxis;
    for (let i = 0; i < 3; i++) {
      this.mats[i]!.color.setHex(i === active ? ARROW_HIGHLIGHT_COLOR : ARROW_COLORS[i]!);
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
