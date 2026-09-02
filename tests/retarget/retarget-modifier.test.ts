import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { BoneMap, identityPreset } from '../../src/retarget/bone-map';
import { RetargetModifier } from '../../src/retarget/retarget-modifier';

/** 源/目标用同一结构：Hips(0,1,0) → Spine(0,0.1,0) → Head(0,0.1,0) */
function buildHumanoid(offset: { hipScale?: number } = {}) {
  const k = offset.hipScale ?? 1;
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1 * k, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1 * k, 0);
  const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.1 * k, 0);
  hips.add(spine); spine.add(head);
  return new SkeletonRig(hips);
}

function poseSource(rig: SkeletonRig) {
  rig.setBasePoseRotation(rig.boneIndex('Spine'), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
  rig.setBasePosePosition(rig.boneIndex('Hips'), new Vector3(0.5, 1, 0));
  rig.update(0); // 源先 update
}

describe('RetargetModifier（局部模式）', () => {
  it('identical rigs: target reproduces source pose', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    const m = new RetargetModifier({ source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()) });
    tgt.addModifier(m);
    tgt.update(0.016);
    // 目标 Spine 局部旋转 = 源的 90° rotZ
    const q = tgt.getBoneAt(tgt.boneIndex('Spine')).quaternion;
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(q.angleTo(expected)).toBeLessThan(1e-4);
    // 目标 Hips 位置跟源
    expect(tgt.getBoneAt(0).position.x).toBeCloseTo(0.5, 4);
  });

  it('scales motion by motionScale ratio (target hips 2x source)', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid({ hipScale: 2 });
    src.motionScale = src.computeMotionScaleFromBone('Hips'); // ≈ 1
    tgt.motionScale = tgt.computeMotionScaleFromBone('Hips'); // ≈ 2
    poseSource(src);
    tgt.addModifier(new RetargetModifier({ source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()) }));
    tgt.update(0.016);
    // Hips 位移 0.5 × (2/1) = 1.0，加 rest 基础 2.0 → y 不变，x = 1.0
    expect(tgt.getBoneAt(0).position.x).toBeCloseTo(1.0, 3);
  });

  it('respects enableFlags (position disabled)', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    tgt.addModifier(new RetargetModifier({
      source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()),
      enableFlags: { position: false, rotation: true },
    }));
    tgt.update(0.016);
    expect(tgt.getBoneAt(0).position.x).toBeCloseTo(0, 5); // 位置未动
    const q = tgt.getBoneAt(tgt.boneIndex('Spine')).quaternion;
    expect(q.angleTo(new Quaternion())).toBeGreaterThan(0.5); // 旋转已应用
  });

  it('rebuilds caches on rest-updated', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    const m = new RetargetModifier({ source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()) });
    tgt.addModifier(m);
    tgt.setRestPose(tgt.boneIndex('Spine'), { position: new Vector3(0, 0.3, 0) }); // 触发 rest-updated
    tgt.update(0.016);
    expect(tgt.getBoneAt(2).position.y).toBeCloseTo(0.1, 4); // Head 局部 rest 未变，不抛错即通过
  });

  it('global mode copies source global pose (absolute)', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    tgt.addModifier(new RetargetModifier({
      source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()), useGlobalPose: true,
    }));
    tgt.update(0.016);
    const srcHeadGlobal = src.getGlobalPosePosition(src.boneIndex('Head'), new Vector3());
    const tgtHeadGlobal = tgt.getGlobalPosePosition(tgt.boneIndex('Head'), new Vector3());
    expect(tgtHeadGlobal.distanceTo(srcHeadGlobal)).toBeLessThan(1e-3);
  });
});
