import { Bone, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { solveIK } from '../../../playground/src/vendor/fullbody-pose-maker/ik';

describe('Fullbody IK torso lock', () => {
  it('keeps the pelvis and spine fixed with active position, rotation and balance targets', () => {
    const pelvis = new Bone();
    const spine = new Bone();
    const arm = new Bone();
    const hand = new Bone();
    spine.position.y = 1;
    arm.position.x = 1;
    hand.position.x = 1;
    pelvis.add(spine);
    spine.add(arm);
    arm.add(hand);

    const target = new Vector3(1.8, 1.6, 0);
    const targetRot = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.atan2(0.6, 0.8));
    solveIK([{ root: pelvis, effector: hand, target, targetRot, rotWeight: 1 }], 160, 0.15, {
      allowRootTranslation: false,
      lockedBones: new Set([pelvis, spine]),
      comSupport: [new Vector3(2, 0, 1)],
      comGain: 0.03,
    });

    expect(pelvis.position.toArray()).toEqual([0, 0, 0]);
    expect(pelvis.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(spine.getWorldPosition(new Vector3()).toArray()).toEqual([0, 1, 0]);
    expect(spine.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(hand.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(0.001);
    expect(hand.getWorldQuaternion(new Quaternion()).angleTo(targetRot)).toBeLessThan(0.001);
  });
});
