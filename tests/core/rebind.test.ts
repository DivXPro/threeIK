import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { CCDIkModifier } from '../../src/modifiers/ik/ccd-ik';

/** 三骨直链：A(0,0,0) → B(0,1,0) → C(0,1,0)，世界空间即 rig 空间 */
function buildChain() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  a.add(b); b.add(c);
  return { a, b, c };
}

describe('SkeletonRig.rebind', () => {
  it('拓扑变更后 rebind 重建 modifier 链缓存，IK 收敛到新末端', () => {
    const { a, b } = buildChain();
    const rig = new SkeletonRig(a);
    const target = new Object3D();
    target.position.set(1, 1.5, 0);
    rig.addModifier(new CCDIkModifier(
      [{ rootBone: 'A', endBone: 'C', target }],
      { maxIterations: 20, angularDeltaLimit: Math.PI }, // 测试不限角度增量
    ));
    rig.update(0.016);
    const targetPos = new Vector3(1, 1.5, 0);
    expect(rig.getGlobalPosePosition(rig.boneIndex('C'), new Vector3()).distanceTo(targetPos)).toBeLessThan(0.01);

    // 在 A、B 间插入新骨 X：DFS 序变为 A,X,B,C，attach 时固化的链索引全部移位
    const x = new Bone(); x.name = 'X'; x.position.set(0, 1, 0);
    a.add(x); x.add(b);
    rig.rebind(a);
    expect(rig.boneCount).toBe(4);

    rig.update(0.016);
    expect(rig.getGlobalPosePosition(rig.boneIndex('C'), new Vector3()).distanceTo(targetPos)).toBeLessThan(0.01);
  });
});
