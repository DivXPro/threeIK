import { describe, it, expect } from 'vitest';
import { HUMANOID_PROFILE, REQUIRED_HUMANOID_BONES, humanoidBoneNames } from '../../src/retarget/humanoid-profile';

describe('HUMANOID_PROFILE', () => {
  it('contains 56 bones matching Godot SkeletonProfileHumanoid', () => {
    expect(HUMANOID_PROFILE.length).toBe(56);
    expect(HUMANOID_PROFILE[0]!.name).toBe('Root');
    expect(HUMANOID_PROFILE[1]!.name).toBe('Hips');
  });

  it('parents reference existing bones (except Root)', () => {
    const names = new Set(humanoidBoneNames());
    for (const b of HUMANOID_PROFILE) {
      if (b.name === 'Root') {
        expect(b.parent).toBeNull();
      } else {
        expect(b.parent).not.toBeNull();
        expect(names.has(b.parent!)).toBe(true);
      }
    }
  });

  it('marks exactly the 17 required bones', () => {
    expect([...REQUIRED_HUMANOID_BONES].sort()).toEqual([
      'Head', 'Hips',
      'LeftFoot', 'LeftHand', 'LeftLowerArm', 'LeftLowerLeg', 'LeftShoulder', 'LeftUpperArm', 'LeftUpperLeg',
      'RightFoot', 'RightHand', 'RightLowerArm', 'RightLowerLeg', 'RightShoulder', 'RightUpperArm', 'RightUpperLeg',
      'Spine',
    ].sort());
    for (const b of HUMANOID_PROFILE) {
      expect(b.required).toBe(REQUIRED_HUMANOID_BONES.includes(b.name));
    }
  });

  it('specific-child tail directions point at existing children', () => {
    for (const b of HUMANOID_PROFILE) {
      if (b.tailDirection === 'specific-child') {
        const tail = HUMANOID_PROFILE.find((x) => x.name === b.boneTail);
        expect(tail?.parent).toBe(b.name);
      }
    }
  });
});
