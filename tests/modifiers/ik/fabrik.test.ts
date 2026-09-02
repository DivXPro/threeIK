import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { FabrikModifier } from '../../../src/modifiers/ik/fabrik';

/** 四骨链：A → B → C → D，各长 1，沿 +Y */
function buildRig() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  const d = new Bone(); d.name = 'D'; d.position.set(0, 1, 0);
  a.add(b); b.add(c); c.add(d);
  const rig = new SkeletonRig(a);
  return rig;
}

describe('FabrikModifier', () => {
  it('reaches a reachable target preserving segment lengths', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(1, 1.8, 0.3);
    rig.addModifier(new FabrikModifier([{ rootBone: 'A', endBone: 'D', target }], { maxIterations: 20, angularDeltaLimit: Math.PI }));
    rig.update(0.016);
    expect(rig.getGlobalPosePosition(3, new Vector3()).distanceTo(new Vector3(1, 1.8, 0.3))).toBeLessThan(0.01);
    // 骨长保持：A→B、B→C、C→D 全局距离仍为 1
    const pa = rig.getGlobalPosePosition(0, new Vector3());
    const pb = rig.getGlobalPosePosition(1, new Vector3());
    const pc = rig.getGlobalPosePosition(2, new Vector3());
    const pd = rig.getGlobalPosePosition(3, new Vector3());
    expect(pb.distanceTo(pa)).toBeCloseTo(1, 3);
    expect(pc.distanceTo(pb)).toBeCloseTo(1, 3);
    expect(pd.distanceTo(pc)).toBeCloseTo(1, 3);
  });

  it('stretches toward an unreachable target', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0, 10, 0);
    rig.addModifier(new FabrikModifier([{ rootBone: 'A', endBone: 'D', target }], { maxIterations: 20 }));
    rig.update(0.016);
    expect(rig.getGlobalPosePosition(3, new Vector3()).y).toBeCloseTo(3, 1);
  });

  it('root stays fixed at its global pose', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0.5, 0.5, 0.5);
    rig.addModifier(new FabrikModifier([{ rootBone: 'A', endBone: 'D', target }], { maxIterations: 20 }));
    rig.update(0.016);
    expect(rig.getGlobalPosePosition(0, new Vector3()).length()).toBeLessThan(1e-5); // root 在原点
  });
});
