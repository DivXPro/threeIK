import { describe, it, expect, vi } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RotateRings } from '../../src/controls/rotate-rings';

const worldQuat = (o: Object3D) => o.getWorldQuaternion(new Quaternion());
const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

function makeProxy(jointPos = new Vector3(0, 0, 0)) {
  const scene = new Object3D();
  const joint = new Object3D();
  joint.position.copy(jointPos);
  scene.add(joint);
  const rings = new RotateRings();
  scene.add(rings);
  rings.setJoint(joint);
  rings.update();
  scene.updateMatrixWorld(true);
  return { scene, joint, rings };
}

/** 模拟 TC 的旋转写入：q_world' = axisAngle(axisWorld, angle) × q_world_start（父 = 场景顶层，quaternion 即世界） */
function simulateTCRotate(rings: RotateRings, axisIndex: number, angle: number, startQuat: Quaternion) {
  const axisWorld = AXES[axisIndex]!.clone().applyQuaternion(startQuat);
  rings.quaternion.copy(new Quaternion().setFromAxisAngle(axisWorld, angle).multiply(startQuat));
}

describe('RotateRings（无头朝向 proxy）', () => {
  it('跟随关节：update 把 proxy 搬到关节位置；非拖拽朝向同步关节', () => {
    const { joint, rings } = makeProxy(new Vector3(1, 2, 3));
    expect(rings.getWorldPosition(new Vector3()).distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    joint.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    joint.updateMatrixWorld(true);
    rings.update();
    const q = worldQuat(rings);
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('朝向携带（FK）：父骨转动时朝向 = 父 × localOffset；updateExternalDrag 重捕局部偏移', () => {
    const { scene, joint, rings } = makeProxy();
    const parent = new Object3D();
    scene.add(parent);
    parent.add(joint); // joint 改挂 parent 下
    scene.updateMatrixWorld(true);
    rings.setOrientationCarry(parent);
    // 父转 90°：proxy 跟随（保持局部偏移）
    parent.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    scene.updateMatrixWorld(true);
    rings.update();
    expect(worldQuat(rings).y).toBeCloseTo(Math.SQRT1_2, 6);
    // 外部操纵器把 proxy 再转 90°（绕世界 Y）→ updateExternalDrag 重捕 localOffset
    const start = worldQuat(rings);
    rings.beginExternalDrag(1);
    rings.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).multiply(start));
    rings.updateExternalDrag();
    rings.endExternalDrag();
    // 父回到恒等：proxy 应保持「用户转过的」局部偏移（总 90°，不弹回）
    parent.quaternion.identity();
    scene.updateMatrixWorld(true);
    rings.update();
    expect(worldQuat(rings).y).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('orientationSource 优先级高于携带与关节同步', () => {
    const { joint, rings } = makeProxy();
    rings.orientationSource = (out) => out.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    joint.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1);
    joint.updateMatrixWorld(true);
    rings.update();
    expect(worldQuat(rings).x).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('增量模式：updateExternalDrag 提取绕冻结拖轴的累计角（swing-twist）', () => {
    const { rings } = makeProxy();
    const deltas: Array<[number, number]> = [];
    rings.onDragDelta = (axisIndex, angle) => deltas.push([axisIndex, angle]);
    const onDragStart = vi.fn();
    rings.onDragStart = onDragStart;
    const start = worldQuat(rings);
    rings.beginExternalDrag(0); // X 环
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0]![0]).toBe(0);
    expect(onDragStart.mock.calls[0]![1].distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-6);
    simulateTCRotate(rings, 0, Math.PI / 2, start);
    rings.updateExternalDrag();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]![1]).toBeCloseTo(Math.PI / 2, 6);
    // 反向再转 -90°：累计角回 0
    simulateTCRotate(rings, 0, 0, start);
    rings.updateExternalDrag();
    expect(deltas[1]![1]).toBeCloseTo(0, 6);
    rings.endExternalDrag();
  });

  it('增量模式：逐次差分累计支持多圈拖拽（三次 90° 累计 = 270°，超 ±π 不回绕）', () => {
    const { rings } = makeProxy();
    const angles: number[] = [];
    rings.onDragDelta = (_a, angle) => angles.push(angle);
    const start = worldQuat(rings);
    rings.beginExternalDrag(1);
    // 单步差分上限 ±π（wrapPi 防跳变），多圈靠逐次累计：三步 90° 与一次 270° 同效
    for (let i = 1; i <= 3; i++) {
      simulateTCRotate(rings, 1, (Math.PI / 2) * i, start);
      rings.updateExternalDrag();
    }
    expect(angles).toHaveLength(3);
    expect(angles[2]).toBeCloseTo(Math.PI * 1.5, 6);
    rings.endExternalDrag();
  });

  it('增量模式：拖拽中 update 不写朝向（TC 接管），endExternalDrag 回落 orientationSource', () => {
    const { joint, rings } = makeProxy();
    rings.orientationSource = (out) => out.identity();
    joint.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 2);
    joint.updateMatrixWorld(true);
    rings.onDragDelta = () => {};
    rings.beginExternalDrag(2);
    rings.update();
    // 拖拽中：朝向不被 orientationSource 覆写（保持 begin 时快照姿态附近；TC 未写就恒等）
    expect(worldQuat(rings).z).toBeCloseTo(0, 6);
    rings.endExternalDrag(); // 松手回落朝向源（恒等）
    expect(worldQuat(rings).z).toBeCloseTo(0, 6);
  });

  it('增量模式拖拽中 proxy 跟手转（TC 写入的朝向不被 update 覆写）', () => {
    const { rings } = makeProxy();
    rings.onDragDelta = () => {};
    const start = worldQuat(rings);
    rings.beginExternalDrag(0);
    simulateTCRotate(rings, 0, Math.PI / 4, start);
    rings.update(); // 拖拽中不写朝向
    expect(worldQuat(rings).x).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    rings.endExternalDrag();
  });

  it('轴子集与视角环配置暴露给 driver（elbow 环：X/Y，无视角环）', () => {
    const rings = new RotateRings({ rings: [0, 1], viewRing: false, ringRadius: 0.32 });
    expect(rings.axisMask).toEqual([true, true, false]);
    expect(rings.viewRing).toBe(false);
    expect(rings.manipulatorSize).toBeCloseTo(2, 6);
  });
});
