export type TailDirection = 'average-children' | 'specific-child' | 'end';
export type ProfileGroup = 'Body' | 'Face' | 'LeftHand' | 'RightHand';

export interface ProfileBone {
  name: string;
  parent: string | null;
  group: ProfileGroup;
  required: boolean;
  tailDirection: TailDirection;
  boneTail?: string;
}

export const HUMANOID_ROOT_BONE = 'Root';
export const HUMANOID_SCALE_BASE_BONE = 'Hips';

/** 与 Godot SkeletonProfileHumanoid 同构（skeleton_profile.cpp 476–852 行） */
export const HUMANOID_PROFILE: readonly ProfileBone[] = [
  { name: 'Root', parent: null, group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'Hips', parent: 'Root', group: 'Body', required: true, tailDirection: 'specific-child', boneTail: 'Spine' },
  { name: 'Spine', parent: 'Hips', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'Chest', parent: 'Spine', group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'UpperChest', parent: 'Chest', group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'Neck', parent: 'UpperChest', group: 'Body', required: false, tailDirection: 'specific-child', boneTail: 'Head' },
  { name: 'Head', parent: 'Neck', group: 'Body', required: true, tailDirection: 'end' },
  { name: 'LeftEye', parent: 'Head', group: 'Face', required: false, tailDirection: 'average-children' },
  { name: 'RightEye', parent: 'Head', group: 'Face', required: false, tailDirection: 'average-children' },
  { name: 'Jaw', parent: 'Head', group: 'Face', required: false, tailDirection: 'average-children' },
  { name: 'LeftShoulder', parent: 'UpperChest', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftUpperArm', parent: 'LeftShoulder', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftLowerArm', parent: 'LeftUpperArm', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftHand', parent: 'LeftLowerArm', group: 'Body', required: true, tailDirection: 'specific-child', boneTail: 'LeftMiddleProximal' },
  { name: 'LeftThumbMetacarpal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftThumbProximal', parent: 'LeftThumbMetacarpal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftThumbDistal', parent: 'LeftThumbProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftIndexProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftIndexIntermediate', parent: 'LeftIndexProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftIndexDistal', parent: 'LeftIndexIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftMiddleProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftMiddleIntermediate', parent: 'LeftMiddleProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftMiddleDistal', parent: 'LeftMiddleIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftRingProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftRingIntermediate', parent: 'LeftRingProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftRingDistal', parent: 'LeftRingIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftLittleProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftLittleIntermediate', parent: 'LeftLittleProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftLittleDistal', parent: 'LeftLittleIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'RightShoulder', parent: 'UpperChest', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightUpperArm', parent: 'RightShoulder', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightLowerArm', parent: 'RightUpperArm', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightHand', parent: 'RightLowerArm', group: 'Body', required: true, tailDirection: 'specific-child', boneTail: 'RightMiddleProximal' },
  { name: 'RightThumbMetacarpal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightThumbProximal', parent: 'RightThumbMetacarpal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightThumbDistal', parent: 'RightThumbProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightIndexProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightIndexIntermediate', parent: 'RightIndexProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightIndexDistal', parent: 'RightIndexIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightMiddleProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightMiddleIntermediate', parent: 'RightMiddleProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightMiddleDistal', parent: 'RightMiddleIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightRingProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightRingIntermediate', parent: 'RightRingProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightRingDistal', parent: 'RightRingIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightLittleProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightLittleIntermediate', parent: 'RightLittleProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightLittleDistal', parent: 'RightLittleIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftUpperLeg', parent: 'Hips', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftLowerLeg', parent: 'LeftUpperLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftFoot', parent: 'LeftLowerLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftToes', parent: 'LeftFoot', group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'RightUpperLeg', parent: 'Hips', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightLowerLeg', parent: 'RightUpperLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightFoot', parent: 'RightLowerLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightToes', parent: 'RightFoot', group: 'Body', required: false, tailDirection: 'average-children' },
];

export const REQUIRED_HUMANOID_BONES: readonly string[] = HUMANOID_PROFILE.filter((b) => b.required).map((b) => b.name);

export function humanoidBoneNames(): string[] {
  return HUMANOID_PROFILE.map((b) => b.name);
}
