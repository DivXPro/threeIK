import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { RollModifier } from '../../../src/modifiers/constraints/roll';

function buildRig() {
  const arm = new Bone(); arm.name = 'Arm'; arm.position.set(0.3, 1, 0);
  const fore = new Bone(); fore.name = 'Fore'; fore.position.set(0.3, 0, 0);
  const hand = new Bone(); hand.name = 'Hand'; hand.position.set(0.3, 0, 0);
  arm.add(fore); fore.add(hand);
  const rig = new SkeletonRig(arm);
  return rig;
}

// rig 姿势存 Float32Array，存储值模长偏离 1 ~1e-8；angleTo 不归一化输入会把模长漂移
// 放大成 ~5e-4 的伪角度（见 constraints.test.ts 同款注释）。比较前先归一化。
function poseAngleTo(rig: SkeletonRig, i: number, expected: Quaternion): number {
  return rig.getPoseRotation(i, new Quaternion()).normalize().angleTo(expected.clone().normalize());
}

describe('RollModifier', () => {
  it('滚转 = 局部右乘：骨骼绕「指向子骨」的自身纵轴原地滚，子骨位置不动', () => {
    const rig = buildRig();
    const fore = rig.boneIndex('Fore');
    const base = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.5);
    rig.setBasePoseRotation(fore, base);
    rig.update(0.016);
    const handBefore = rig.getGlobalPosePosition(rig.boneIndex('Hand'), new Vector3());

    rig.addModifier(new RollModifier([{ applyBone: 'Fore', childBone: 'Hand', angle: Math.PI / 2 }]));
    rig.update(0.016);

    // 局部旋转 = 基础旋转 × 绕子骨轴(+x) 滚 π/2
    const expected = base.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
    expect(poseAngleTo(rig, fore, expected)).toBeLessThan(1e-5);
    // 子骨在纵轴上：世界位置不变
    const handAfter = rig.getGlobalPosePosition(rig.boneIndex('Hand'), new Vector3());
    expect(handAfter.distanceTo(handBefore)).toBeLessThan(1e-6);
  });

  it('angle 0 不碰骨骼；setAngle 可随时改通道角', () => {
    const rig = buildRig();
    const fore = rig.boneIndex('Fore');
    const mod = new RollModifier([{ applyBone: 'Fore', childBone: 'Hand' }]);
    rig.addModifier(mod);
    rig.update(0.016);
    expect(rig.getPoseRotation(fore, new Quaternion()).angleTo(new Quaternion())).toBeLessThan(1e-6);

    mod.setAngle(0, Math.PI / 4);
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 4);
    expect(poseAngleTo(rig, fore, expected)).toBeLessThan(1e-5);
  });

  it('amount 缩放滚转角', () => {
    const rig = buildRig();
    const fore = rig.boneIndex('Fore');
    rig.addModifier(new RollModifier([{ applyBone: 'Fore', childBone: 'Hand', angle: Math.PI / 2, amount: 0.5 }]));
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 4);
    expect(poseAngleTo(rig, fore, expected)).toBeLessThan(1e-5);
  });
});
