import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { IKChain } from '../../../src/modifiers/ik/ik-chain';

/** 直链：A(0,0,0) → B(0,1,0) → C(0,1,0) → D(0,1,0)，另有一支 Hips 兄弟验证祖先校验 */
function buildChainRig() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  const d = new Bone(); d.name = 'D'; d.position.set(0, 1, 0);
  a.add(b); b.add(c); c.add(d);
  const rig = new SkeletonRig(a);
  rig.update(0);
  return rig;
}

describe('IKChain', () => {
  it('builds joints by walking parent chain from end to root', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    expect(chain.joints).toEqual([0, 1, 2, 3]);
  });

  it('rejects chains where root is not an ancestor of end', () => {
    const rig = buildChainRig();
    expect(() => new IKChain(rig, { rootBone: 'D', endBone: 'A', target: new Object3D() }))
      .toThrowError(/ancestor/);
  });

  it('initJoints fills chain positions from global pose and solver info from rest', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    chain.initJoints(rig);
    expect(chain.chain.length).toBe(4); // 无虚拟端点：4 个 joint 头
    expect(chain.chain[1]!.y).toBeCloseTo(1, 5);
    expect(chain.chain[3]!.y).toBeCloseTo(3, 5);
    const info = chain.solverInfos[0]!;
    expect(info.length).toBeCloseTo(1, 6);
    expect(info.forwardVector.y).toBeCloseTo(1, 5); // 局部朝 +Y
    expect(chain.solverInfos[3]).toBeNull(); // 末骨无子骨 → 不求解
  });

  it('extendEndBone appends a virtual end using from-parent axis', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, {
      rootBone: 'A', endBone: 'D', target: new Object3D(),
      extendEndBone: true, endBoneLength: 0.5,
    });
    chain.initJoints(rig);
    expect(chain.chain.length).toBe(5);
    expect(chain.getChainEnd().y).toBeCloseTo(3.5, 5);
    expect(chain.solverInfos[3]!.length).toBeCloseTo(0.5, 6);
  });

  it('cacheCurrentVectors derives global unit vectors from chain coordinates', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    chain.initJoints(rig);
    // 手动挪动末端：使 segment C→D 指向纯 +Z（chain[2] 在 (0,2,0)），单位向量 z 应为 1
    chain.chain[3]!.set(0, 2, 1);
    chain.cacheCurrentVectors(rig);
    expect(chain.solverInfos[2]!.currentVector.z).toBeCloseTo(1, 5);
  });

  it('updateChainCoordinateFw guards against 180-degree flips', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    chain.initJoints(rig);
    // 把 chain[0] 移到会使 head→tail 方向完全反向的位置：当前 tail[1] 在 (0,1,0)，原方向 +Y，
    // 新 head 放在 (0,2,0) 使新方向为 -Y → 触发防翻转，head 回退
    chain.updateChainCoordinateFw(rig, 0, new Vector3(0, 2, 0));
    expect(chain.chain[0]!.y).toBeCloseTo(0, 5); // 回退：chain[0] 未变
  });
});
