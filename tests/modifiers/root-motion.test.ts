import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { RootMotionModifier } from '../../src/modifiers/root-motion';

function buildHips(scale = 1) {
  const container = new Object3D();
  container.scale.setScalar(scale);
  const hips = new Bone(); hips.name = 'Hips';
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  container.add(hips); hips.add(spine);
  const rig = new SkeletonRig(hips);
  return { rig, hips, container };
}

describe('RootMotionModifier', () => {
  it('pins the root bone pose position to the target world position', () => {
    const { rig, hips } = buildHips();
    const target = new Object3D();
    target.position.set(1, 2, 3);
    rig.addModifier(new RootMotionModifier('Hips', target));
    rig.update(0.016);
    expect(hips.position.distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    // 子骨局部姿势不动（相对父骨）
    expect(rig.getBoneAt(1).position.y).toBeCloseTo(0.1, 6);
  });

  it('follows the target across frames (re-seeded from base each update)', () => {
    const { rig, hips } = buildHips();
    const target = new Object3D();
    rig.addModifier(new RootMotionModifier('Hips', target));
    rig.update(0.016);
    target.position.set(0, 0.5, 0);
    rig.update(0.016);
    expect(hips.position.distanceTo(new Vector3(0, 0.5, 0))).toBeLessThan(1e-6);
  });

  it('converts through scaled ancestors (model scale 0.01)', () => {
    const { rig, hips, container } = buildHips(0.01);
    container.updateMatrixWorld(true);
    const target = new Object3D();
    target.position.set(0, 1, 0); // 世界系 1m
    rig.addModifier(new RootMotionModifier('Hips', target));
    rig.update(0.016);
    // 骨骼局部坐标须放大 100 倍，合成回世界才是 1m
    expect(hips.position.y).toBeCloseTo(100, 4);
    const world = hips.getWorldPosition(new Vector3());
    expect(world.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-4);
  });

  it('rejects a non-root bone at attach time', () => {
    const { rig } = buildHips();
    const target = new Object3D();
    expect(() => rig.addModifier(new RootMotionModifier('Spine', target))).toThrowError(/必须是 rig 根骨/);
  });

  it('serializes bone and target name', () => {
    const target = new Object3D();
    target.name = 'hipsTarget';
    const mod = new RootMotionModifier('Hips', target);
    expect(mod.toJSON()).toEqual({ bone: 'Hips', target: 'hipsTarget' });
  });
});
