import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { AimModifier } from '../../../src/modifiers/constraints/aim';
import { CopyTransformModifier } from '../../../src/modifiers/constraints/copy-transform';

function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.5, 0);
  const hand = new Bone(); hand.name = 'Hand'; hand.position.set(0.3, 0.2, 0);
  hips.add(head); hips.add(hand);
  const rig = new SkeletonRig(hips);
  return rig;
}

describe('AimModifier', () => {
  it('aims the bone axis at the reference object', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(2, 1.5, 0); // 世界 = rig 空间（root 无父变换）
    rig.addModifier(new AimModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: target, axis: '+y' }]));
    rig.update(0.016);
    const gq = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    const aimed = new Vector3(0, 1, 0).applyQuaternion(gq);
    const headPos = rig.getGlobalPosePosition(rig.boneIndex('Head'), new Vector3());
    const desired = new Vector3(2, 1.5, 0).sub(headPos).normalize();
    expect(aimed.distanceTo(desired)).toBeLessThan(1e-3);
  });

  it('amount 0.5 halves the aim correction', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(2, 1.5, 0);
    rig.addModifier(new AimModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: target, amount: 0.5 }]));
    rig.update(0.016);
    const gq = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    const aimed = new Vector3(0, 1, 0).applyQuaternion(gq);
    // 半量：方向应在 +Y 与 desired 之间（与两者都有夹角）
    expect(aimed.y).toBeGreaterThan(0.5);
    expect(aimed.x).toBeGreaterThan(0.1);
  });
});

describe('CopyTransformModifier', () => {
  it('copies rotation from another bone (global space)', () => {
    const rig = buildRig();
    const srcQ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.8);
    rig.setBasePoseRotation(rig.boneIndex('Hand'), srcQ);
    rig.addModifier(new CopyTransformModifier([{ applyBone: 'Head', referenceType: 'bone', referenceBone: 'Hand' }]));
    rig.update(0.016);
    const gq = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    const expected = rig.getGlobalPoseQuaternion(rig.boneIndex('Hand'), new Quaternion());
    // 偏差4（见 task-14 报告）：比较前归一化。rig 全局姿势存 Float32Array，存储值模长
    // 偏离 1 ~1.7e-8；angleTo 不归一化输入，acos 在 dot≈1 处把模长漂移放大为 ~5.2e-4
    // 的伪角度（两四元数逐位相同、自身对自身比较亦如此）。归一化后阈值 1e-4 语义不变。
    expect(gq.normalize().angleTo(expected.normalize())).toBeLessThan(1e-4);
  });
});
