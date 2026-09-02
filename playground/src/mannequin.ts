import * as THREE from 'three';
import { SkeletonRig, HUMANOID_PROFILE } from 'threeik';

/** 按 profile 层级生成无网格骨架（SkeletonHelper 可视化），scale 缩放肢体长度 */
export function buildMannequin(scale = 1.4): { root: THREE.Object3D; rig: SkeletonRig } {
  // 骨架比例表（单位米，沿主轴 -Y 向下/±X 向两侧的人形惯例；只生成 Body 主干 + 四肢，手指略）
  const L: Record<string, [number, number, number]> = {
    Root: [0, 0, 0],
    Hips: [0, 0.95, 0],
    Spine: [0, 0.12, 0], Chest: [0, 0.14, 0], UpperChest: [0, 0.14, 0],
    Neck: [0, 0.1, 0], Head: [0, 0.12, 0],
    LeftShoulder: [0.06, 0.05, 0], LeftUpperArm: [0.16, 0, 0], LeftLowerArm: [0.27, 0, 0], LeftHand: [0.26, 0, 0],
    RightShoulder: [-0.06, 0.05, 0], RightUpperArm: [-0.16, 0, 0], RightLowerArm: [-0.27, 0, 0], RightHand: [-0.26, 0, 0],
    LeftUpperLeg: [0.1, -0.05, 0], LeftLowerLeg: [0, -0.42, 0], LeftFoot: [0, -0.42, 0], LeftToes: [0, -0.05, 0.12],
    RightUpperLeg: [-0.1, -0.05, 0], RightLowerLeg: [0, -0.42, 0], RightFoot: [0, -0.42, 0], RightToes: [0, -0.05, 0.12],
  };
  const bones = new Map<string, THREE.Bone>();
  const root = new THREE.Object3D();
  for (const pb of HUMANOID_PROFILE) {
    const local = L[pb.name];
    if (!local) continue; // 手指/面部不生成
    const bone = new THREE.Bone();
    bone.name = pb.name;
    bone.position.set(local[0] * scale, local[1] * scale, local[2] * scale);
    bones.set(pb.name, bone);
    const parentBone = pb.parent ? bones.get(pb.parent) : undefined;
    if (parentBone) parentBone.add(bone);
    else root.add(bone);
  }
  root.add(new THREE.SkeletonHelper(bones.get('Hips')!));
  const rig = new SkeletonRig(bones.get('Root')!);
  return { root, rig };
}
