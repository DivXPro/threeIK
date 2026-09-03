export { SkeletonRig } from './core/skeleton-rig';
export { ThreeIKError } from './core/errors';
export type { WarningPayload } from './core/events';
export type { BoneAxis, BoneDirection, RotationAxis, SecondaryDirection } from './core/bone-axes';

export { Modifier } from './modifiers/modifier';

export { CCDIkModifier } from './modifiers/ik/ccd-ik';
export { FabrikModifier } from './modifiers/ik/fabrik';
export { TwoBoneIkModifier } from './modifiers/ik/two-bone-ik';
export { IterateIKModifier } from './modifiers/ik/iterate-ik';
export { JointLimitation, ConeJointLimitation } from './modifiers/ik/joint-limitation';
export type { IKChainConfig, JointConfig } from './modifiers/ik/ik-chain';
export type { IterateIKOptions } from './modifiers/ik/iterate-ik';
export type { TwoBoneIKConfig } from './modifiers/ik/two-bone-ik';

export { AimModifier } from './modifiers/constraints/aim';
export type { AimConfig, BoneConstraintConfig } from './modifiers/constraints/aim';
export { CopyTransformModifier } from './modifiers/constraints/copy-transform';
export type { CopyTransformConfig } from './modifiers/constraints/copy-transform';

export { RootMotionModifier } from './modifiers/root-motion';

export { RetargetModifier } from './retarget/retarget-modifier';
export type { RetargetConfig, RetargetFlags } from './retarget/retarget-modifier';
export { BoneMap, mixamoPreset, readyPlayerMePreset, vrmPreset, identityPreset, suggestBoneMap } from './retarget/bone-map';
export { HUMANOID_PROFILE, REQUIRED_HUMANOID_BONES, HUMANOID_ROOT_BONE, HUMANOID_SCALE_BASE_BONE, humanoidBoneNames } from './retarget/humanoid-profile';
export type { ProfileBone, ProfileGroup, TailDirection } from './retarget/humanoid-profile';
