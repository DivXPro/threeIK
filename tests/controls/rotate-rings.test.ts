import { describe, it, expect, vi } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RotateRings } from '../../src/controls/rotate-rings';
import { makeCamera, makeDomStub } from './test-utils';

const R = 0.5; // 测试用环半径（投影坐标好算）

function makeRings(jointPos = new Vector3(0, 0, 0), camera?: ReturnType<typeof makeCamera>) {
  // 相机斜置：正对 Z 轴会让 X 环（YZ 平面）把相机包进环平面，射线∩平面退化打不中
  const cam = camera ?? makeCamera(0.5, 1, 4, 0, 0, 0);
  const dom = makeDomStub();
  const scene = new Object3D();
  const joint = new Object3D();
  joint.position.copy(jointPos);
  scene.add(joint);
  scene.updateMatrixWorld(true);
  const rings = new RotateRings(cam, dom, { ringRadius: R });
  scene.add(rings);
  rings.setJoint(joint);
  rings.update();
  scene.updateMatrixWorld(true);
  return { camera: cam, dom, scene, joint, rings };
}

/** 世界坐标 → 桩屏幕坐标（800×600） */
function clientFor(camera: ReturnType<typeof makeCamera>, world: Vector3) {
  const v = world.clone().project(camera);
  return { clientX: ((v.x + 1) / 2) * 800, clientY: ((-v.y + 1) / 2) * 600, pointerId: 1 };
}

const worldQuat = (rings: RotateRings) => rings.getWorldQuaternion(new Quaternion());

describe('RotateRings', () => {
  it('跟随关节：update 把环心搬到关节位置，非拖拽时朝向同步关节', () => {
    const { joint, rings } = makeRings(new Vector3(1, 2, 3));
    expect(rings.getWorldPosition(new Vector3()).distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    joint.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    joint.updateMatrixWorld(true);
    rings.update();
    const q = worldQuat(rings);
    expect(q.x).toBeCloseTo(0, 6);
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('拖 X 环：从环顶拖到环前 = 绕 X 轴 +90°（+Y 转向 +Z）', () => {
    const { camera, dom, rings } = makeRings();
    const rr = R * rings.scale.x; // 屏幕恒定大小：世界半径 = 设定半径 × 距离缩放
    dom.fire('pointerdown', clientFor(camera, new Vector3(0, rr, 0)));
    expect(rings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, new Vector3(0, 0, rr)));
    const q = worldQuat(rings);
    const y = new Vector3(0, 1, 0).applyQuaternion(q);
    expect(y.x).toBeCloseTo(0, 5);
    expect(y.y).toBeCloseTo(0, 5);
    expect(y.z).toBeCloseTo(1, 5);
    dom.fire('pointerup', {});
    expect(rings.isDragging).toBe(false);
  });

  it('拖视角环：屏幕右侧点拖到顶部 = 绕 +Z +90°（+X 转向 +Y）', () => {
    // 视角环永远面向相机，用正相机（朝 -Z）几何以屏平面为环平面，角度精确
    const { camera, dom, rings } = makeRings(new Vector3(), makeCamera(0, 0, 5, 0, 0, 0));
    const rv = R * 1.3 * rings.scale.x; // 视角环半径（× 屏幕恒定大小缩放）
    dom.fire('pointerdown', clientFor(camera, new Vector3(rv, 0, 0)));
    expect(rings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, new Vector3(0, rv, 0)));
    const x = new Vector3(1, 0, 0).applyQuaternion(worldQuat(rings));
    expect(x.x).toBeCloseTo(0, 5);
    expect(x.y).toBeCloseTo(1, 5);
    expect(x.z).toBeCloseTo(0, 5);
    dom.fire('pointerup', {});
  });

  it('远离环不触发拖拽；setInteractive(false) 后命中也不触发', () => {
    const { camera, dom, rings } = makeRings();
    dom.fire('pointerdown', clientFor(camera, new Vector3(2, 2, 0)));
    expect(rings.isDragging).toBe(false);
    rings.setInteractive(false);
    dom.fire('pointerdown', clientFor(camera, new Vector3(0, R * rings.scale.x, 0)));
    expect(rings.isDragging).toBe(false);
  });

  it('拖拽中朝向不被 update 同步覆盖；松手后再次同步关节', () => {
    const { camera, dom, joint, rings } = makeRings();
    const rr = R * rings.scale.x;
    dom.fire('pointerdown', clientFor(camera, new Vector3(0, rr, 0)));
    dom.fire('pointermove', clientFor(camera, new Vector3(0, 0, rr)));
    const dragged = worldQuat(rings).clone();
    rings.update(); // 拖拽中：朝向保持用户写入值
    expect(worldQuat(rings).angleTo(dragged)).toBeLessThan(1e-6);
    dom.fire('pointerup', {});
    joint.quaternion.identity();
    joint.updateMatrixWorld(true);
    rings.update(); // 松手：重新同步关节朝向（identity）
    expect(worldQuat(rings).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('拖拽锁视角控制；dispose 移除监听器且中途 dispose 归还锁', () => {
    const camera = makeCamera(0.5, 1, 4, 0, 0, 0);
    const dom = makeDomStub();
    const dragControl = { lock: vi.fn(), unlock: vi.fn() };
    const rings = new RotateRings(camera, dom, { ringRadius: R, dragControl });
    const joint = new Object3D();
    rings.setJoint(joint);
    rings.update();
    const rr = R * rings.scale.x; // 屏幕恒定大小：世界半径 = 设定半径 × 距离缩放
    dom.fire('pointerdown', clientFor(camera, new Vector3(0, rr, 0)));
    expect(rings.isDragging).toBe(true);
    expect(dragControl.lock).toHaveBeenCalledTimes(1);
    rings.dispose();
    expect(dragControl.unlock).toHaveBeenCalledTimes(1);
    expect(dom.listenerCount('pointerdown')).toBe(0);
    expect(dom.listenerCount('pointermove')).toBe(0);
    expect(dom.listenerCount('pointerup')).toBe(0);
    dom.fire('pointerdown', clientFor(camera, new Vector3(0, rr, 0)));
    expect(rings.isDragging).toBe(false);
  });
});
