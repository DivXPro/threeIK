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

  it('NaN reference object is guarded: warns once and leaves the bone untouched', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(NaN, NaN, NaN);
    const warnings: unknown[] = [];
    rig.on('warning', (p) => warnings.push(p));
    rig.addModifier(new AimModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: target }]));
    rig.update(0.016);
    const q = rig.getBoneAt(rig.boneIndex('Head')).quaternion;
    expect(Number.isNaN(q.x + q.y + q.z + q.w)).toBe(false);
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6); // 本帧跳过，保持 rest
    expect(warnings.length).toBe(1);
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

  it('NaN reference position is guarded (copyPosition): warns once, pose untouched', () => {
    const rig = buildRig();
    const ref = new Object3D();
    ref.position.set(NaN, 0, 0);
    const warnings: unknown[] = [];
    rig.on('warning', (p) => warnings.push(p));
    rig.addModifier(new CopyTransformModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: ref, copyRotation: false, copyPosition: true }]));
    rig.update(0.016);
    const head = rig.getBoneAt(rig.boneIndex('Head'));
    expect(Number.isNaN(head.position.x + head.position.y + head.position.z)).toBe(false);
    expect(head.position.distanceTo(new Vector3(0, 0.5, 0))).toBeLessThan(1e-6); // rest 局部位置
    expect(warnings.length).toBe(1);
  });

  it('NaN reference quaternion is guarded (copyRotation): warns once, pose untouched', () => {
    const rig = buildRig();
    const ref = new Object3D();
    ref.quaternion.set(NaN, NaN, NaN, NaN);
    const warnings: unknown[] = [];
    rig.on('warning', (p) => warnings.push(p));
    rig.addModifier(new CopyTransformModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: ref, copyRotation: true, copyPosition: false }]));
    rig.update(0.016);
    const q = rig.getBoneAt(rig.boneIndex('Head')).quaternion;
    expect(Number.isNaN(q.x + q.y + q.z + q.w)).toBe(false);
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6); // 本帧跳过，保持 rest
    expect(warnings.length).toBe(1);
  });
});

describe('CopyTransformModifier · parentShare 旋转分摊', () => {
  // Hips → Neck → Head：分摊作用在「Head 的增量 → Neck 分担一份」
  function buildNeckRig() {
    const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
    const neck = new Bone(); neck.name = 'Neck'; neck.position.set(0, 0.4, 0);
    const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.15, 0);
    hips.add(neck); neck.add(head);
    return new SkeletonRig(hips);
  }

  it('parentShare=0.5：世界增量对半分给父骨，本骨世界朝向仍精确等于期望', () => {
    const rig = buildNeckRig();
    const ref = new Object3D();
    ref.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); // 世界 yaw 90°
    rig.addModifier(new CopyTransformModifier([{
      applyBone: 'Head', referenceType: 'object', referenceObject: ref, parentShare: 0.5,
    }]));
    rig.update(0.016);
    // 本骨世界朝向 = 期望（任意分摊比例下精确，归一化后比较——Float32 存储，见上方偏差4注释）
    const headG = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    expect(headG.normalize().angleTo(ref.quaternion)).toBeLessThan(1e-4);
    // rest 全单位 → D = 90° yaw，父骨承担一半 = 45°
    const neckG = rig.getGlobalPoseQuaternion(rig.boneIndex('Neck'), new Quaternion());
    expect(neckG.normalize().angleTo(new Quaternion())).toBeCloseTo(Math.PI / 4, 3);
  });

  it('parentShare 缺省：父骨不动（现状不变）', () => {
    const rig = buildNeckRig();
    const ref = new Object3D();
    ref.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    rig.addModifier(new CopyTransformModifier([{
      applyBone: 'Head', referenceType: 'object', referenceObject: ref,
    }]));
    rig.update(0.016);
    const headG = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    expect(headG.normalize().angleTo(ref.quaternion)).toBeLessThan(1e-4);
    const neckG = rig.getGlobalPoseQuaternion(rig.boneIndex('Neck'), new Quaternion());
    expect(neckG.normalize().angleTo(new Quaternion())).toBeLessThan(1e-6);
  });
});
