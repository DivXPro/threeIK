import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../core/skeleton-rig';
import { Modifier } from '../modifiers/modifier';
import { BoneMap, identityPreset } from './bone-map';
import { HUMANOID_PROFILE, type ProfileBone } from './humanoid-profile';

export interface RetargetFlags {
  position?: boolean;
  rotation?: boolean;
  scale?: boolean;
}

export interface RetargetConfig {
  source: SkeletonRig;
  sourceBoneMap: BoneMap;
  /** 目标（本 rig）骨名映射，缺省 identity */
  boneMap?: BoneMap;
  useGlobalPose?: boolean;
  enableFlags?: RetargetFlags;
  profile?: readonly ProfileBone[];
}

interface RetargetBoneInfo {
  sourceIdx: number;
  targetIdx: number;
  preBasis: Matrix3;
  postBasis: Matrix3;
}

const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _q4 = new Quaternion();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _m1 = new Matrix3();
const _m4 = new Matrix4();

/** Quaternion → Matrix3（列主序 3x3 旋转矩阵，与 Godot Basis 对应） */
function quatToMatrix3(q: Quaternion, out: Matrix3): Matrix3 {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return out.set(
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  );
}

/** Matrix3 → Quaternion（three.js setFromRotationMatrix 只接受 Matrix4，经 _m4 桥接） */
function quatFromMatrix3(m: Matrix3, out: Quaternion): Quaternion {
  const te = m.elements; // 列主序：te[0]=n11, te[1]=n21, te[2]=n31, te[3]=n12, ...
  _m4.set(
    te[0]!, te[3]!, te[6]!, 0,
    te[1]!, te[4]!, te[7]!, 0,
    te[2]!, te[5]!, te[8]!, 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(_m4);
}

/**
 * 挂在目标 rig 上的重定向（translate retarget_modifier_3d.cpp）。
 * 契约：源 rig 先于目标 rig update。
 */
export class RetargetModifier extends Modifier {
  private infos: RetargetBoneInfo[] = [];
  private readonly useGlobalPose: boolean;
  private readonly flags: Required<RetargetFlags>;
  private readonly profile: readonly ProfileBone[];
  private readonly sourceBoneMap: BoneMap;
  private readonly targetBoneMap: BoneMap;
  private readonly source: SkeletonRig;
  private unsubRest?: () => void;
  private unsubSourceRest?: () => void;

  constructor(config: RetargetConfig) {
    super();
    this.source = config.source;
    this.sourceBoneMap = config.sourceBoneMap;
    this.targetBoneMap = config.boneMap ?? BoneMap.fromPreset(identityPreset());
    this.useGlobalPose = config.useGlobalPose ?? false;
    this.flags = { position: config.enableFlags?.position ?? true, rotation: config.enableFlags?.rotation ?? true, scale: config.enableFlags?.scale ?? false };
    this.profile = config.profile ?? HUMANOID_PROFILE;
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.rebuildCache(rig);
    this.unsubRest = rig.on('rest-updated', () => this.rebuildCache(rig));
    this.unsubSourceRest = this.source.on('rest-updated', () => this.rebuildCache(rig));
  }

  override detach(): void {
    this.unsubRest?.();
    this.unsubSourceRest?.();
    super.detach();
  }

  /** 预计算 pre/post basis（translate cache_bone_rests / cache_bone_global_rests；attach 时执行，允许分配） */
  private rebuildCache(rig: SkeletonRig): void {
    this.infos = [];
    for (const bone of this.profile) {
      const srcName = this.sourceBoneMap.findModelBone(bone.name);
      const tgtName = this.targetBoneMap.findModelBone(bone.name);
      if (!srcName || !tgtName) continue;
      const sourceIdx = this.source.findBoneIndex(srcName);
      const targetIdx = rig.findBoneIndex(tgtName);
      if (sourceIdx < 0 || targetIdx < 0) continue;

      const srcParent = this.source.getParentIndex(sourceIdx);
      const tgtParent = rig.getParentIndex(targetIdx);
      const srcParentGrest = srcParent >= 0 ? this.source.getGlobalRestQuaternion(srcParent, new Quaternion()) : new Quaternion();
      const tgtParentGrest = tgtParent >= 0 ? rig.getGlobalRestQuaternion(tgtParent, new Quaternion()) : new Quaternion();
      const srcRest = this.source.getRestQuaternion(sourceIdx, new Quaternion());
      const tgtRest = rig.getRestQuaternion(targetIdx, new Quaternion());

      const pre = new Matrix3();
      const post = new Matrix3();
      const tmp = new Matrix3();

      // 局部模式：pre = tgtParentGrest⁻¹ × srcParentGrest（全局模式运行时不使用 pre，恒等即可）
      if (!this.useGlobalPose) {
        quatToMatrix3(tgtParentGrest.clone().invert(), pre);
        quatToMatrix3(srcParentGrest, tmp);
        pre.multiply(tmp);
      }
      // post = srcRest⁻¹ × srcParentGrest⁻¹ × tgtParentGrest × tgtRest（两模式相同）
      quatToMatrix3(srcRest.clone().invert(), post);
      quatToMatrix3(srcParentGrest.clone().invert(), tmp);
      post.multiply(tmp);
      quatToMatrix3(tgtParentGrest, tmp);
      post.multiply(tmp);
      quatToMatrix3(tgtRest, tmp);
      post.multiply(tmp);

      this.infos.push({ sourceIdx, targetIdx, preBasis: pre, postBasis: post });
    }
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    const ratio = rig.motionScale / this.source.motionScale;
    for (const info of this.infos) {
      if (this.useGlobalPose) {
        this.retargetGlobal(rig, info);
      } else {
        this.retargetLocal(rig, info, ratio);
      }
    }
  }

  /** 局部模式（translate _retarget_pose 359–370 行） */
  private retargetLocal(rig: SkeletonRig, info: RetargetBoneInfo, ratio: number): void {
    if (this.flags.rotation) {
      // basis = pre × srcPose.basis × post（Matrix3 乘法，Matrix3.premultiply/multiply 与 Godot Basis 乘法同序）
      this.source.getPoseRotation(info.sourceIdx, _q1);
      quatToMatrix3(_q1, _m1);
      _m1.premultiply(info.preBasis).multiply(info.postBasis);
      quatFromMatrix3(_m1, _q2);
      rig.setPoseRotation(info.targetIdx, _q2.normalize());
    }
    if (this.flags.position) {
      // origin = pre × ((srcPosePos − srcRestPos) × ratio) + tgtRestPos
      this.source.getPosePosition(info.sourceIdx, _v1);
      this.source.getRestPosition(info.sourceIdx, _v2);
      _v1.sub(_v2).multiplyScalar(ratio).applyMatrix3(info.preBasis);
      rig.getRestPosition(info.targetIdx, _v2);
      rig.setPosePosition(info.targetIdx, _v1.add(_v2));
    }
    if (this.flags.scale) {
      rig.warnOnce('retarget-scale-unsupported', 'RetargetModifier: scale flag is not supported in v1 (ignored)');
    }
  }

  /** 全局模式（translate _retarget_global_pose 300–327 行） */
  private retargetGlobal(rig: SkeletonRig, info: RetargetBoneInfo): void {
    const parent = rig.getParentIndex(info.targetIdx);
    const parentG = parent >= 0 ? rig.getGlobalPoseQuaternion(parent, _q3) : _q3.identity();
    // parentG 即 _q3（out 别名）；先在 _q4 算出 parentGInv，_q3 全程保持 parentG 不被就地反转
    _q4.copy(parentG).invert();
    if (this.flags.rotation) {
      // tgtGlobal.basis = srcGlobal.basis × post；写回局部 = parentGpose⁻¹ × tgtGlobal
      this.source.getGlobalPoseQuaternion(info.sourceIdx, _q1);
      quatToMatrix3(_q1, _m1);
      _m1.multiply(info.postBasis);
      quatFromMatrix3(_m1, _q2);
      _q2.premultiply(_q4).normalize();
      rig.setPoseRotation(info.targetIdx, _q2);
    }
    if (this.flags.position) {
      // tgtGlobal.origin = srcGlobal.origin（绝对拷贝）；转局部 = parentG⁻¹ × (global − parentGlobalPos)
      this.source.getGlobalPosePosition(info.sourceIdx, _v1);
      if (parent >= 0) rig.getGlobalPosePosition(parent, _v2);
      else _v2.set(0, 0, 0);
      _v1.sub(_v2).applyQuaternion(_q4);
      rig.setPosePosition(info.targetIdx, _v1);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      type: 'retarget',
      useGlobalPose: this.useGlobalPose,
      enableFlags: { ...this.flags },
      boneMap: this.targetBoneMap.toJSON(),
      sourceBoneMap: this.sourceBoneMap.toJSON(),
    };
  }
}
