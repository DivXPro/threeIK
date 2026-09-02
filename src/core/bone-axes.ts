import { Vector3 } from 'three';

export type BoneAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export type BoneDirection = BoneAxis | 'from-parent';
export type SecondaryDirection = 'none' | BoneAxis | 'custom';
export type RotationAxis = 'x' | 'y' | 'z' | 'all' | 'custom';

const BONE_AXIS_VECTORS: Record<BoneAxis, readonly [number, number, number]> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

export function vectorFromBoneAxis(axis: BoneAxis, out: Vector3): Vector3 {
  const v = BONE_AXIS_VECTORS[axis];
  return out.set(v[0], v[1], v[2]);
}

export function vectorFromSecondaryDirection(dir: SecondaryDirection, custom: Vector3 | undefined, out: Vector3): Vector3 {
  if (dir === 'none') return out.set(0, 0, 0);
  if (dir === 'custom') return custom ? out.copy(custom) : out.set(0, 0, 0);
  return vectorFromBoneAxis(dir, out);
}

export function vectorFromRotationAxis(axis: RotationAxis, custom: Vector3 | undefined, out: Vector3): Vector3 {
  if (axis === 'all') return out.set(0, 0, 0);
  if (axis === 'custom') return custom ? out.copy(custom) : out.set(0, 0, 0);
  return vectorFromBoneAxis(`+${axis}` as BoneAxis, out);
}
