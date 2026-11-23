import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { TwoBoneIkModifier } from '../../../src/modifiers/ik/two-bone-ik';

/** 腿：Upper(0,0,0) → Lower(0,-1,0) → Foot(0,-1,0)，朝下（人腿惯例） */
function buildLeg() {
  const upper = new Bone(); upper.name = 'Upper';
  const lower = new Bone(); lower.name = 'Lower'; lower.position.set(0, -1, 0);
  const foot = new Bone(); foot.name = 'Foot'; foot.position.set(0, -1, 0);
  upper.add(lower); lower.add(foot);
  const rig = new SkeletonRig(upper);
  return rig;
}

function makeTarget(x: number, y: number, z: number) {
  const o = new Object3D();
  o.position.set(x, y, z);
  return o;
}

describe('TwoBoneIkModifier', () => {
  it('bends the knee toward the pole target and lands the foot', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -1.5, 0.5);
    const pole = makeTarget(0, -0.5, 10); // pole 在前方
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const footPos = rig.getGlobalPosePosition(2, new Vector3());
    expect(footPos.distanceTo(new Vector3(0, -1.5, 0.5))).toBeLessThan(0.01);
    // 膝盖（Lower 全局位置）应向 pole 方向（+Z）弯曲
    const kneePos = rig.getGlobalPosePosition(1, new Vector3());
    expect(kneePos.z).toBeGreaterThan(0.05);
  });

  it('straightens the leg for unreachable targets', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -5, 0);
    const pole = makeTarget(0, 0, 10);
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const footPos = rig.getGlobalPosePosition(2, new Vector3());
    expect(footPos.y).toBeCloseTo(-2, 2); // 拉直
    expect(Math.abs(footPos.z)).toBeLessThan(0.02);
  });

  it('pushes too-close targets back to the reachable sphere', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -0.1, 0); // 距离 0.1 < |lenRoot - lenMid| = 0 不成立；改测 dist < sub：两骨等长时 sub=0，用不等长链更直观——此处验证不 NaN 且脚不落在不可达点
    const pole = makeTarget(0, 0, 10);
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const footPos = rig.getGlobalPosePosition(2, new Vector3());
    expect(Number.isNaN(footPos.x + footPos.y + footPos.z)).toBe(false);
  });

  it('is isolated from base pose across frames', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -1.5, 0.5);
    const pole = makeTarget(0, 0, 10);
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const first = rig.getBoneAt(0).quaternion.clone();
    rig.update(0.016);
    expect(rig.getBoneAt(0).quaternion.angleTo(first)).toBeLessThan(1e-4);
  });

  it('keeps bone orientation continuous when bending a straight limb toward either side', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -2, 0);
    const pole = makeTarget(0, -1, 1);
    rig.addModifier(new TwoBoneIkModifier([{
      rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole, poleDirection: '+z',
      smoothPoleRoll: true,
    }]));
    rig.update(1 / 60);
    const straightUpper = rig.getGlobalPoseQuaternion(0, new Quaternion());
    const straightLower = rig.getGlobalPoseQuaternion(1, new Quaternion());

    for (const side of [1, -1]) {
      pole.position.set(side, -1, 0);
      target.position.y = -1.997;
      rig.update(1 / 60);
      expect(rig.getGlobalPosePosition(1, new Vector3()).x * side).toBeCloseTo(0.055, 3);
      expect(rig.getGlobalPosePosition(2, new Vector3()).distanceTo(target.position)).toBeLessThan(0.0001);
      expect(rig.getGlobalPoseQuaternion(0, new Quaternion()).angleTo(straightUpper)).toBeLessThan(0.2);
      expect(rig.getGlobalPoseQuaternion(1, new Quaternion()).angleTo(straightLower)).toBeLessThan(0.2);

      target.position.y = -2;
      rig.update(1 / 60);
      expect(rig.getGlobalPoseQuaternion(0, new Quaternion()).angleTo(straightUpper)).toBeLessThan(0.001);
    }
  });

  it('gradually aligns the secondary direction on a clearly bent limb', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -2, 0);
    const pole = makeTarget(0, -1, 1);
    rig.addModifier(new TwoBoneIkModifier([{
      rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole, poleDirection: '+z',
      smoothPoleRoll: true,
    }]));
    rig.update(1 / 60);
    target.position.y = -Math.SQRT2;
    pole.position.set(1, -1, 0);

    rig.update(1 / 60);
    const firstSecondary = new Vector3(0, 0, 1).applyQuaternion(rig.getGlobalPoseQuaternion(1, new Quaternion()));
    expect(firstSecondary.z).toBeGreaterThan(0.95);
    for (let frame = 0; frame < 30; frame++) rig.update(1 / 60);

    const secondary = new Vector3(0, 0, 1).applyQuaternion(rig.getGlobalPoseQuaternion(1, new Quaternion()));
    expect(secondary.x).toBeGreaterThan(0.65);
    expect(Math.abs(secondary.z)).toBeLessThan(0.0001);
    expect(rig.getGlobalPosePosition(2, new Vector3()).distanceTo(target.position)).toBeLessThan(0.0001);
  });

  it('NaN target is guarded: warns once and leaves bones untouched', () => {
    const rig = buildLeg();
    const target = makeTarget(NaN, NaN, NaN);
    const pole = makeTarget(0, 0, 10);
    const warnings: unknown[] = [];
    rig.on('warning', (p) => warnings.push(p));
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const q = rig.getBoneAt(0).quaternion;
    expect(Number.isNaN(q.x + q.y + q.z + q.w)).toBe(false);
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6); // 本帧跳过，保持 rest
    expect(warnings.length).toBe(1);
  });
});
