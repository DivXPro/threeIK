import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';

function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  const chest = new Bone(); chest.name = 'Chest'; chest.position.set(0, 0.1, 0);
  hips.add(spine); spine.add(chest);
  return new SkeletonRig(hips);
}

describe('working pose & global pose', () => {
  it('global pose composes down the chain (no rotation)', () => {
    const rig = buildRig();
    rig.update(0);
    const g = rig.getGlobalPosePosition(2, new Vector3());
    expect(g.y).toBeCloseTo(1.2, 5);
  });

  it('setPoseRotation rotates the whole subtree in global space', () => {
    const rig = buildRig();
    rig.update(0);
    // Spine 绕 Z 转 90°：Chest 全局位置 = Hips(0,1,0) + (0.1,0,0) 旋转后 (0,0,0)→ 具体：
    // Spine 全局位置 (0,1.1,0)，Chest 相对 (0,0.1,0) 绕 Z 转 90° → (0,1.1,0) + (-0.1,0,0) = (-0.1, 1.1, 0)
    rig.setPoseRotation(1, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
    const g = rig.getGlobalPosePosition(2, new Vector3());
    expect(g.x).toBeCloseTo(-0.1, 5);
    expect(g.y).toBeCloseTo(1.1, 5);
    const gq = rig.getGlobalPoseQuaternion(2, new Quaternion());
    const v = new Vector3(1, 0, 0).applyQuaternion(gq);
    expect(v.y).toBeCloseTo(1, 5);
  });

  it('setPosePosition moves subtree', () => {
    const rig = buildRig();
    rig.update(0);
    rig.setPosePosition(1, new Vector3(0, 0.5, 0));
    // Chest 全局 = Hips(0,1,0) + Spine(0,0.5,0) + Chest 自身偏移(0,0.1,0) = 1.6
    expect(rig.getGlobalPosePosition(2, new Vector3()).y).toBeCloseTo(1.6, 5);
  });

  it('update() without modifiers writes base pose to bones', () => {
    const rig = buildRig();
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    rig.setBasePoseRotation(1, q);
    rig.update(0.016);
    expect(rig.getBoneAt(1).quaternion.angleTo(q)).toBeLessThan(1e-6);
  });

  it('exposes subtree span (nested-set interval)', () => {
    const rig = buildRig();
    expect(rig.getSubtreeSpan(0)).toBe(3);
    expect(rig.getSubtreeSpan(2)).toBe(1);
  });
});
