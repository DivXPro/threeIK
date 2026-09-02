import { describe, it, expect } from 'vitest';
import * as threeik from '../src/index';

describe('public API', () => {
  it('exports the full surface', () => {
    const expected = [
      'SkeletonRig', 'ThreeIKError', 'Modifier',
      'CCDIkModifier', 'FabrikModifier', 'TwoBoneIkModifier',
      'JointLimitation', 'ConeJointLimitation',
      'AimModifier', 'CopyTransformModifier',
      'RetargetModifier', 'BoneMap', 'HUMANOID_PROFILE', 'REQUIRED_HUMANOID_BONES',
      'mixamoPreset', 'readyPlayerMePreset', 'vrmPreset', 'identityPreset', 'suggestBoneMap',
    ];
    for (const name of expected) {
      expect(threeik, name).toHaveProperty(name);
    }
  });
});
