import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { CCDIkModifier } from '../../../src/modifiers/ik/ccd-ik';

/** 三骨直链：Root(0,0,0) → Mid(0,1,0) → End(0,1,0)，世界空间即 rig 空间 */
function buildRig() {
  const root = new Bone(); root.name = 'Root';
  const mid = new Bone(); mid.name = 'Mid'; mid.position.set(0, 1, 0);
  const end = new Bone(); end.name = 'End'; end.position.set(0, 1, 0);
  root.add(mid); mid.add(end);
  const rig = new SkeletonRig(root);
  return rig;
}

function endEffectorPos(rig: SkeletonRig, out: Vector3): Vector3 {
  return rig.getGlobalPosePosition(2, out);
}

describe('CCDIkModifier', () => {
  it('reaches a reachable target', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(1, 1.5, 0);
    rig.addModifier(new CCDIkModifier(
      [{ rootBone: 'Root', endBone: 'End', target }],
      { maxIterations: 20, angularDeltaLimit: Math.PI }, // 测试不限角度增量
    ));
    rig.update(0.016);
    const pos = endEffectorPos(rig, new Vector3());
    expect(pos.distanceTo(new Vector3(1, 1.5, 0))).toBeLessThan(0.01);
  });

  it('stretches toward an unreachable target', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0, 5, 0);
    rig.addModifier(new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target }], { maxIterations: 20 }));
    rig.update(0.016);
    const pos = endEffectorPos(rig, new Vector3());
    expect(pos.y).toBeCloseTo(2, 2); // 链总长 2，拉直朝 +Y
    expect(Math.abs(pos.x)).toBeLessThan(0.05);
  });

  it('is isolated from base pose across frames（无累积）', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(1, 1, 0);
    rig.addModifier(new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target }], { maxIterations: 10 }));
    rig.update(0.016);
    const first = rig.getBoneAt(1).quaternion.clone();
    rig.update(0.016);
    expect(rig.getBoneAt(1).quaternion.angleTo(first)).toBeLessThan(1e-4);
  });

  it('influence 0 leaves pose untouched', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(2, 0, 0);
    const m = new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target }]);
    m.influence = 0;
    rig.addModifier(m);
    rig.update(0.016);
    expect(rig.getBoneAt(1).quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('resolves string targets via rig.targetResolver', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0.5, 1, 0);
    rig.targetResolver = (key) => (key === 'hand-target' ? target : null);
    rig.addModifier(new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target: 'hand-target' }], { maxIterations: 20, angularDeltaLimit: Math.PI }));
    rig.update(0.016);
    expect(endEffectorPos(rig, new Vector3()).distanceTo(new Vector3(0.5, 1, 0))).toBeLessThan(0.01);
  });
});
