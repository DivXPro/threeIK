import { describe, it, expect, vi } from 'vitest';
import { Bone, Group, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';

/** Hips(0,1,0) → Spine(0,0.1,0) → Chest(0,0.1,0) → LeftArm(0.05,0,0, rotZ 90deg) */
function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  const chest = new Bone(); chest.name = 'Chest'; chest.position.set(0, 0.1, 0);
  const arm = new Bone(); arm.name = 'LeftArm'; arm.position.set(0.05, 0, 0);
  arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  hips.add(spine); spine.add(chest); chest.add(arm);
  return { rig: new SkeletonRig(hips), hips, spine, chest, arm };
}

describe('SkeletonRig construction', () => {
  it('flattens bones in DFS order with parent indices and spans', () => {
    const { rig } = buildRig();
    expect(rig.boneNames).toEqual(['Hips', 'Spine', 'Chest', 'LeftArm']);
    expect(rig.getParentIndex(0)).toBe(-1);
    expect(rig.getParentIndex(1)).toBe(0);
    expect(rig.getParentIndex(3)).toBe(2);
    expect(rig.boneCount).toBe(4);
  });

  it('resolves bone names; throws/falls back for missing', () => {
    const { rig } = buildRig();
    expect(rig.boneIndex('Chest')).toBe(2);
    expect(() => rig.boneIndex('Nope')).toThrowError(/Nope/);
    expect(rig.findBoneIndex('Nope')).toBe(-1);
  });

  it('captures rest pose from initial bone TRS and composes global rest', () => {
    const { rig } = buildRig();
    const restPos = rig.getRestPosition(3, new Vector3());
    expect(restPos.x).toBeCloseTo(0.05, 6);
    // Chest 全局 rest 位置 = (0, 1.2, 0)
    const g = rig.getGlobalRestPosition(2, new Vector3());
    expect(g.x).toBeCloseTo(0, 5);
    expect(g.y).toBeCloseTo(1.2, 5);
    // LeftArm 全局 rest 旋转 = 父链无旋转 ∘ rotZ(90°)
    const gq = rig.getGlobalRestQuaternion(3, new Quaternion());
    const v = new Vector3(1, 0, 0).applyQuaternion(gq);
    expect(v.y).toBeCloseTo(1, 5);
  });

  it('throws when root has no bones', () => {
    expect(() => new SkeletonRig(new Group())).toThrowError();
  });
});

describe('base pose', () => {
  it('setBasePoseRotation writes base buffer and Bone', () => {
    const { rig, spine } = buildRig();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    rig.setBasePoseRotation(1, q);
    expect(spine.quaternion.angleTo(q)).toBeLessThan(1e-6);
    expect(rig.getBasePoseRotation(1, new Quaternion()).angleTo(q)).toBeLessThan(1e-6);
  });

  it('captureBasePose reads externally-animated bone TRS', () => {
    const { rig, chest } = buildRig();
    chest.position.set(0.5, 0.5, 0.5); // 模拟 AnimationMixer 写入
    rig.captureBasePose();
    expect(rig.getBasePosePosition(2, new Vector3()).x).toBeCloseTo(0.5, 6);
  });

  it('resetToRest restores base pose and bones', () => {
    const { rig, chest } = buildRig();
    chest.position.set(9, 9, 9);
    rig.captureBasePose();
    rig.resetToRest();
    expect(chest.position.y).toBeCloseTo(0.1, 6);
  });

  it('emits rest-updated on setRestPose and recomputes global rest', () => {
    const { rig } = buildRig();
    const cb = vi.fn();
    rig.on('rest-updated', cb);
    rig.setRestPose(1, { position: new Vector3(0, 0.5, 0) });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(rig.getGlobalRestPosition(2, new Vector3()).y).toBeCloseTo(1.6, 5);
  });

  it('serializes rest pose data (toJSON)', () => {
    const { rig } = buildRig();
    const json = rig.toJSON();
    expect(json.bones.length).toBe(4);
    expect(json.bones[0]).toMatchObject({ name: 'Hips', parent: null, position: [0, 1, 0] });
    expect(json.bones[3]).toMatchObject({ name: 'LeftArm', parent: 'Chest' });
  });
});

describe('rig space', () => {
  it('worldToRigSpace converts via root bone parent transform', () => {
    const { rig, hips } = buildRig();
    const armature = new Group();
    armature.position.set(10, 0, 0);
    armature.add(hips);
    armature.updateMatrixWorld(true);
    const out = rig.worldToRigSpace(new Vector3(10, 1.2, 0), new Vector3());
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(1.2, 5);
  });
});
