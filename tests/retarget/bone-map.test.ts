import { describe, it, expect } from 'vitest';
import { BoneMap, mixamoPreset, readyPlayerMePreset, vrmPreset, identityPreset, suggestBoneMap } from '../../src/retarget/bone-map';
import { REQUIRED_HUMANOID_BONES } from '../../src/retarget/humanoid-profile';

describe('BoneMap', () => {
  it('resolves both directions and round-trips JSON', () => {
    const map = BoneMap.fromPreset(mixamoPreset());
    expect(map.findModelBone('LeftUpperArm')).toBe('mixamorig:LeftArm');
    expect(map.findModelBone('LeftLowerLeg')).toBe('mixamorig:LeftLeg');
    expect(map.findProfileBone('mixamorig:LeftFoot')).toBe('LeftFoot');
    const restored = BoneMap.fromJSON(map.toJSON());
    expect(restored.findModelBone('Hips')).toBe('mixamorig:Hips');
  });

  it('covers all 17 required bones in every preset', () => {
    for (const preset of [mixamoPreset(), readyPlayerMePreset(), vrmPreset(), identityPreset()]) {
      const map = BoneMap.fromPreset(preset);
      for (const name of REQUIRED_HUMANOID_BONES) {
        expect(map.findModelBone(name), `${name}`).not.toBeNull();
      }
    }
  });

  it('maps fingers per Godot profile (Thumb1 → Metacarpal …)', () => {
    const map = BoneMap.fromPreset(mixamoPreset());
    expect(map.findModelBone('LeftThumbMetacarpal')).toBe('mixamorig:LeftHandThumb1');
    expect(map.findModelBone('RightIndexDistal')).toBe('mixamorig:RightHandIndex3');
    expect(map.findModelBone('LeftLittleProximal')).toBe('mixamorig:LeftHandPinky1');
  });

  it('suggestBoneMap detects mixamo naming with/without prefix', () => {
    const withPrefix = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head', 'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot'];
    const s1 = suggestBoneMap(withPrefix);
    expect(s1.coverage).toBe(1);
    expect(s1.map.findModelBone('LeftUpperArm')).toBe('mixamorig:LeftArm');

    const noPrefix = withPrefix.map((n) => n.replace('mixamorig:', ''));
    expect(suggestBoneMap(noPrefix).coverage).toBe(1);
  });
});
