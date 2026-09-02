import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { IKChain } from '../../../src/modifiers/ik/ik-chain';

/** 直链 A(0,0,0) → B(0,1,0) → C(0,1,0) */
function buildRig() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  a.add(b); b.add(c);
  const rig = new SkeletonRig(a);
  rig.update(0);
  return rig;
}

describe('cacheCurrentJointRotations', () => {
  it('converts a bent chain into local bone rotations (all axes free)', () => {
    const rig = buildRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'C', target: new Bone() });
    chain.initJoints(rig);
    // 手动把末端扳到 +X 方向：B→C 方向从 +Y 变为 +X
    chain.chain[2]!.set(1, 1, 0);
    chain.cacheCurrentVectors(rig);
    chain.cacheCurrentJointRotations(rig);
    // B 骨（joints[1]）局部旋转应使全局 B→C 方向为 +X
    const lpose = chain.solverInfos[1]!.currentLpose;
    const parentG = new Quaternion();
    rig.getGlobalPoseQuaternion(0, parentG);
    const g = parentG.multiply(lpose);
    const dir = new Vector3(0, 1, 0).applyQuaternion(g); // forwardVector 局部 +Y
    expect(dir.x).toBeCloseTo(1, 4);
    expect(dir.y).toBeCloseTo(0, 4);
  });

  it('respects angularDeltaLimit (clamps per-iteration angle change)', () => {
    const rig = buildRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'C', target: new Bone() });
    chain.initJoints(rig);
    chain.chain[2]!.set(1, 1, 0);
    chain.cacheCurrentVectors(rig);
    const limit = Math.PI / 90; // 2°
    chain.cacheCurrentJointRotations(rig, limit);
    const lpose = chain.solverInfos[1]!.currentLpose;
    expect(lpose.angleTo(new Quaternion())).toBeLessThanOrEqual(limit + 1e-4);
  });

  it('rotation axis projection keeps rotation in the axis plane', () => {
    const rig = buildRig();
    const chain = new IKChain(rig, {
      rootBone: 'A', endBone: 'C', target: new Bone(),
      joints: { B: { rotationAxis: 'z' } }, // B 只允许绕 Z 转
    });
    chain.initJoints(rig);
    chain.chain[2]!.set(0, 1, 1); // 目标在 +Z，Z 轴平面投影后 B→C 应保持 +Y（投影到 XY 平面）
    chain.cacheCurrentVectors(rig);
    chain.cacheCurrentJointRotations(rig);
    const lpose = chain.solverInfos[1]!.currentLpose;
    // 纯 Z 轴旋转保持 (0,0,1) 不变（旋转轴平行 Z）
    const fixed = new Vector3(0, 0, 1).applyQuaternion(lpose);
    expect(fixed.z).toBeCloseTo(1, 4);
  });
});
