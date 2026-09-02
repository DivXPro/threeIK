import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { ThreeIKError } from '../../core/errors';
import { isZeroApprox, isEqualApprox, snapVectorToPlane, xformQuat, xformQuatInv } from '../../core/math';
import { vectorFromBoneAxis, vectorFromRotationAxis, vectorFromSecondaryDirection } from '../../core/bone-axes';
import type { BoneDirection, RotationAxis, SecondaryDirection } from '../../core/bone-axes';
import type { JointLimitation } from './joint-limitation';

export interface JointConfig {
  rotationAxis?: RotationAxis;
  rotationAxisVector?: Vector3;
  limitation?: JointLimitation | null;
  limitationRightAxis?: SecondaryDirection;
  limitationRightAxisVector?: Vector3;
  limitationRotationOffset?: Quaternion;
  useRestForLimitation?: boolean;
}

export interface IKChainConfig {
  rootBone: string;
  endBone: string;
  /** Object3D 直接引用，或字符串 key（由 rig.targetResolver 解析，theatre 接入用） */
  target: Object3D | string;
  extendEndBone?: boolean;
  endBoneDirection?: BoneDirection;
  endBoneLength?: number;
  joints?: Record<string, JointConfig>;
}

export interface SolverInfo {
  currentLpose: Quaternion;
  currentLrest: Quaternion;
  currentGpose: Quaternion;
  currentGrest: Quaternion;
  currentVector: Vector3; // 全局、单位
  forwardVector: Vector3; // 局部、单位
  length: number;
}

/** 解析后的逐关节设置（Godot IterateIK3DJointSetting） */
export class JointSetting {
  rotationAxis: RotationAxis = 'all';
  rotationAxisVector = new Vector3(1, 0, 0);
  limitation: JointLimitation | null = null;
  limitationRightAxis: SecondaryDirection = 'none';
  limitationRightAxisVector = new Vector3(1, 0, 0);
  limitationRotationOffset = new Quaternion();
  limitationOffsetDelta = new Quaternion(); // 运行时：useRestForLimitation 的 rest 补偿
  useRestForLimitation = false;

  constructor(config?: JointConfig) {
    if (!config) return;
    if (config.rotationAxis !== undefined) this.rotationAxis = config.rotationAxis;
    if (config.rotationAxisVector) this.rotationAxisVector.copy(config.rotationAxisVector);
    if (config.limitation !== undefined) this.limitation = config.limitation;
    if (config.limitationRightAxis !== undefined) this.limitationRightAxis = config.limitationRightAxis;
    if (config.limitationRightAxisVector) this.limitationRightAxisVector.copy(config.limitationRightAxisVector);
    if (config.limitationRotationOffset) this.limitationRotationOffset.copy(config.limitationRotationOffset);
    if (config.useRestForLimitation !== undefined) this.useRestForLimitation = config.useRestForLimitation;
  }

  getRotationAxisVector(out: Vector3): Vector3 {
    return vectorFromRotationAxis(this.rotationAxis, this.rotationAxisVector, out);
  }

  getLimitationRightAxisVector(out: Vector3): Vector3 {
    return vectorFromSecondaryDirection(this.limitationRightAxis, this.limitationRightAxisVector, out);
  }
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _q1 = new Quaternion();

/** Godot: IKModifier3D::get_bone_axis（固定 mutableBoneAxes=true） */
export function getBoneAxis(rig: SkeletonRig, bone: number, direction: BoneDirection, out: Vector3): Vector3 {
  if (direction === 'from-parent') {
    // axis = restQuat(bone)^-1 * posePosition(bone)，归一化
    rig.getRestQuaternion(bone, _q1);
    rig.getPosePosition(bone, out);
    xformQuatInv(_q1, out, out);
    const len = out.length();
    if (!isZeroApprox(len)) out.multiplyScalar(1 / len);
    return out;
  }
  return vectorFromBoneAxis(direction, out);
}

/** Godot: ChainIK3DSetting + IterateIK3DSetting 的链状态（翻译，不含 NodePath/信号） */
export class IKChain {
  readonly joints: number[] = [];
  readonly chain: Vector3[] = [];
  readonly solverInfos: (SolverInfo | null)[] = [];
  readonly jointSettings: JointSetting[] = [];
  readonly rootBone: number;
  readonly endBone: number;
  readonly extendEndBone: boolean;
  readonly endBoneDirection: BoneDirection;
  readonly endBoneLength: number;
  simulated = false;

  constructor(rig: SkeletonRig, public readonly config: IKChainConfig) {
    this.rootBone = rig.boneIndex(config.rootBone);
    this.endBone = rig.boneIndex(config.endBone);
    this.extendEndBone = config.extendEndBone ?? false;
    this.endBoneDirection = config.endBoneDirection ?? 'from-parent';
    this.endBoneLength = config.endBoneLength ?? 0;

    // 从 endBone 沿父链走到 rootBone（root 必须是 end 的严格祖先）
    const path: number[] = [];
    let cur = this.endBone;
    while (cur !== -1 && cur !== this.rootBone) {
      path.push(cur);
      cur = rig.getParentIndex(cur);
    }
    if (cur !== this.rootBone) {
      throw ThreeIKError.invalidChain(
        `"${config.rootBone}" is not an ancestor of "${config.endBone}"`,
      );
    }
    path.push(this.rootBone);
    path.reverse();
    if (path.length < 2) {
      throw ThreeIKError.invalidChain(`root and end must be different bones ("${config.rootBone}")`);
    }
    this.joints = path;
    for (let i = 0; i < path.length; i++) {
      const boneName = rig.getBoneName(path[i]!);
      this.jointSettings.push(new JointSetting(config.joints?.[boneName]));
      this.solverInfos.push(null);
      this.chain.push(new Vector3());
    }
  }

  getChainEnd(): Vector3 {
    return this.chain[this.chain.length - 1]!;
  }

  /** 翻译 IterateIK3DSetting::init_joints —— 每帧从当前全局姿势重建链 */
  initJoints(rig: SkeletonRig): void {
    const extendsEnd = this.extendEndBone && this.endBoneLength > 0;
    const targetLen = this.joints.length + (extendsEnd ? 1 : 0);
    for (let i = 0; i < this.joints.length; i++) {
      rig.getGlobalPosePosition(this.joints[i]!, this.chain[i]!);
      const last = i === this.joints.length - 1;
      if (last && extendsEnd) {
        getBoneAxis(rig, this.endBone, this.endBoneDirection, _v1);
        if (isZeroApprox(_v1.lengthSq())) {
          this.solverInfos[i] = null;
          continue;
        }
        const info = (this.solverInfos[i] ??= createSolverInfo());
        this.jointSettings[i]!.getRotationAxisVector(_v2);
        snapVectorToPlane(_v2, _v1, info.forwardVector).normalize();
        info.length = this.endBoneLength;
        // 虚拟端点 = 全局姿势变换(axis * length) + 末骨全局位置（slot 复用，不逐帧分配）
        rig.getGlobalPoseQuaternion(this.joints[i]!, _q1);
        xformQuat(_q1, _v1.multiplyScalar(this.endBoneLength), _v1).add(this.chain[i]!);
        if (this.chain.length < targetLen) this.chain.push(_v1.clone());
        else this.chain[this.chain.length - 1]!.copy(_v1);
      } else if (!last) {
        rig.getRestPosition(this.joints[i + 1]!, _v1); // 子骨局部 rest 原点 = 父→子方向
        if (isZeroApprox(_v1.lengthSq())) {
          this.solverInfos[i] = null;
          continue;
        }
        const info = (this.solverInfos[i] ??= createSolverInfo());
        this.jointSettings[i]!.getRotationAxisVector(_v2);
        snapVectorToPlane(_v2, _v1, info.forwardVector).normalize();
        info.length = _v1.length();
      } else {
        this.solverInfos[i] = null;
      }
    }
    this.chain.length = targetLen; // 统一裁剪/保持
    this.initCurrentJointRotations(rig);
  }

  /** 翻译 ChainIK3DSetting::init_current_joint_rotations —— 以当前姿势为求解初值 */
  initCurrentJointRotations(rig: SkeletonRig): void {
    const parent = rig.getParentIndex(this.rootBone);
    const parentGpose = _q1.identity();
    if (parent >= 0) rig.getGlobalPoseQuaternion(parent, parentGpose);
    for (let i = 0; i < this.joints.length; i++) {
      const info = this.solverInfos[i];
      if (!info) continue;
      rig.getPoseRotation(this.joints[i]!, info.currentLrest);
      info.currentGrest.copy(parentGpose).multiply(info.currentLrest).normalize();
      info.currentLpose.copy(info.currentLrest);
      info.currentGpose.copy(parentGpose).multiply(info.currentLpose).normalize();
      parentGpose.copy(info.currentGpose);
    }
    this.cacheCurrentVectors(rig);
  }

  /** 翻译 update_chain_coordinate（允许翻转版，chain_ik_3d.h 63–73 行） */
  updateChainCoordinate(rig: SkeletonRig, index: number, position: Vector3): void {
    if (isZeroApprox(this.chain[index]!.distanceTo(position))) return;
    this.chain[index]!.copy(position);
    this.cacheCurrentVector(rig, index);
  }

  /** 翻译 update_chain_coordinate_bw（含防翻转守卫，chain_ik_3d.h 75–100 行） */
  updateChainCoordinateBw(rig: SkeletonRig, index: number, position: Vector3): void {
    if (isZeroApprox(this.chain[index]!.distanceTo(position))) return;
    const head = index - 1;
    if (head >= 0 && head < this.solverInfos.length) {
      const info = this.solverInfos[head];
      if (info) {
        _v1.copy(position).sub(this.chain[head]!).normalize(); // new head→tail
        if (isEqualApprox(info.currentVector.dot(_v1), -1)) {
          // 回退 tail，视为无变化
          this.chain[index]!.copy(this.chain[head]!).addScaledVector(info.currentVector, info.length);
          return;
        }
      }
    }
    this.chain[index]!.copy(position);
    this.cacheCurrentVector(rig, index);
  }

  /** 翻译 update_chain_coordinate_fw（chain_ik_3d.h 102–127 行） */
  updateChainCoordinateFw(rig: SkeletonRig, index: number, position: Vector3): void {
    if (isZeroApprox(this.chain[index]!.distanceTo(position))) return;
    const head = index;
    const tail = index + 1;
    if (tail >= 0 && tail < this.solverInfos.length) {
      const info = this.solverInfos[head];
      if (info) {
        _v1.copy(this.chain[tail]!).sub(position).normalize(); // new head→tail
        if (isEqualApprox(info.currentVector.dot(_v1), -1)) {
          this.chain[index]!.copy(this.chain[tail]!).addScaledVector(info.currentVector, -info.length);
          return;
        }
      }
    }
    this.chain[index]!.copy(position);
    this.cacheCurrentVector(rig, index);
  }

  cacheCurrentVectors(rig: SkeletonRig): void {
    for (let i = 0; i < this.joints.length; i++) {
      this.cacheCurrentVector(rig, i);
    }
  }

  /** 翻译 cache_current_vector（chain_ik_3d.h 129–146 行）：chain[index] 移动影响 head=index-1 与 head=index 两个 segment */
  private cacheCurrentVector(_rig: SkeletonRig, index: number): void {
    const headA = index - 1; // tail = index
    if (headA >= 0) {
      const info = this.solverInfos[headA];
      if (info) {
        info.currentVector.copy(this.chain[index]!).sub(this.chain[headA]!);
        const len = info.currentVector.length();
        if (!isZeroApprox(len)) info.currentVector.multiplyScalar(1 / len);
      }
    }
    const tailB = index + 1; // head = index
    if (tailB < this.chain.length) {
      const info = this.solverInfos[index];
      if (info) {
        info.currentVector.copy(this.chain[tailB]!).sub(this.chain[index]!);
        const len = info.currentVector.length();
        if (!isZeroApprox(len)) info.currentVector.multiplyScalar(1 / len);
      }
    }
  }
}

function createSolverInfo(): SolverInfo {
  return {
    currentLpose: new Quaternion(),
    currentLrest: new Quaternion(),
    currentGpose: new Quaternion(),
    currentGrest: new Quaternion(),
    currentVector: new Vector3(),
    forwardVector: new Vector3(),
    length: 0,
  };
}
