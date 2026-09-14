import { describe, it, expect } from 'vitest';
import * as threeik from '../src/index';
import * as controls from '../src/controls';
import type {
  ExternalDraggable,
  HotkeyEvent,
  HotkeyMap,
  HotkeyTarget,
  ManipulatorAttachOptions,
  ManipulatorDriver,
} from '../src/controls';

describe('public API', () => {
  it('exports the full surface', () => {
    const expected = [
      'SkeletonRig', 'ThreeIKError', 'Modifier',
      'CCDIkModifier', 'FabrikModifier', 'TwoBoneIkModifier',
      'JointLimitation', 'ConeJointLimitation',
      'AimModifier', 'CopyTransformModifier',
      'RootMotionModifier',
      'RetargetModifier', 'BoneMap', 'HUMANOID_PROFILE', 'REQUIRED_HUMANOID_BONES',
      'mixamoPreset', 'readyPlayerMePreset', 'vrmPreset', 'identityPreset', 'suggestBoneMap',
    ];
    for (const name of expected) {
      expect(threeik, name).toHaveProperty(name);
    }
  });

  it('controls entry：操纵器驱动公共面（TransformControlsDriver / 尺寸常量 / 类型导出）', () => {
    expect(typeof controls.TransformControlsDriver).toBe('function');
    expect(typeof controls.DEFAULT_BALL_RADIUS).toBe('number');
    expect(controls.DEFAULT_BALL_RADIUS).toBeGreaterThan(0);
    expect(typeof controls.DEFAULT_RING_RADIUS).toBe('number');
    expect(controls.DEFAULT_RING_RADIUS).toBeGreaterThan(0);
    // 类型导出可编译（运行期擦除，仅做类型探针）
    type Probe = {
      driver: ManipulatorDriver;
      attach: ManipulatorAttachOptions;
      draggable: ExternalDraggable;
      map: HotkeyMap;
      event: HotkeyEvent;
      target: HotkeyTarget;
    };
    const probe = null as unknown as Probe;
    expect(probe).toBeNull();
  });
});
