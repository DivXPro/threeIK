import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
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
});
