import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { vectorFromBoneAxis, type BoneAxis } from '../../core/bone-axes';
import { getFromToRotation, xformQuat } from '../../core/math';
import { Modifier } from '../modifier';

export interface BoneConstraintConfig {
  amount?: number;
  applyBone: string;
  referenceType: 'bone' | 'object';
  referenceBone?: string;
  referenceObject?: Object3D | string;
}

export interface AimConfig extends BoneConstraintConfig {
  axis?: BoneAxis;
}

// 模块临时量（一次性分配，processModification 热路径零分配）。单次迭代内占用约定：
// - _refPos:   resolveReference 输出（参考点 rig 空间全局位置），消费于 _desired 计算
// - _bonePos/_gpose: 目标骨全局位置/旋转；_gpose 消费于 _forward 与 _deltaRot.multiply(_gpose)，此后死亡
// - _axis/_forward/_desired: 轴向 → 当前朝向 → 期望朝向，逐语句消费
// - _prevQ:    当前局部旋转（getPoseRotation），须跨 getFromToRotation/_parentG/_local 计算存活，
//              直至 amount<1 分支作 slerp 的 qa 被消费；此区间禁止任何 setPoseRotation 调用
// - _deltaRot: 先为 from-to 增量，multiply(_gpose) 后为目标全局旋转
// - _parentG:  父全局旋转，copy/invert 一次性消费于 _local 计算
// - _mixQ:     amount 混合中转（裁决1：slerpQuaternions 的 qb 不得与 this 同参）
// - _local:    目标局部旋转 → setPoseRotation 写出
const _axis = new Vector3();
const _forward = new Vector3();
const _desired = new Vector3();
const _refPos = new Vector3();
const _bonePos = new Vector3();
const _parentG = new Quaternion();
const _gpose = new Quaternion();
const _deltaRot = new Quaternion(); // 命名避开 processModification 的 _delta: number 参数遮蔽（brief 原名 _delta 不可编译，见报告偏差1）
const _local = new Quaternion();
const _prevQ = new Quaternion();
const _mixQ = new Quaternion();

export class AimModifier extends Modifier {
  constructor(private configs: AimConfig[]) {
    super();
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const c of this.configs) {
      const bone = rig.boneIndex(c.applyBone);
      if (!resolveReference(rig, c, _refPos)) continue;

      rig.getGlobalPosePosition(bone, _bonePos);
      rig.getGlobalPoseQuaternion(bone, _gpose);
      vectorFromBoneAxis(c.axis ?? '+y', _axis);
      xformQuat(_gpose, _axis, _forward).normalize();
      _desired.copy(_refPos).sub(_bonePos);
      if (_desired.lengthSq() < 1e-10) continue;
      _desired.normalize();

      // delta * gpose → 目标全局旋转 → 转局部
      rig.getPoseRotation(bone, _prevQ);
      getFromToRotation(_forward, _desired, _prevQ, _deltaRot);
      _deltaRot.multiply(_gpose); // 目标全局
      const parent = rig.getParentIndex(bone);
      if (parent >= 0) rig.getGlobalPoseQuaternion(parent, _parentG);
      _local.copy(parent >= 0 ? _parentG.invert() : _parentG.identity()).multiply(_deltaRot).normalize();

      const amount = c.amount ?? 1;
      if (amount < 1) {
        // 裁决1：three.js slerpQuaternions(qa, qb, t) = this.copy(qa).slerp(qb, t)；
        // qb 与 this 同参时 copy(qa) 先覆写 qb，slerp(qb≡qa) 恒返回 qa，amount 静默失效。
        // 经 _mixQ 中转；qa 复用 _prevQ（当前局部旋转，自读取后此间无 setPoseRotation，值仍有效）。
        _mixQ.copy(_local);
        _local.slerpQuaternions(_prevQ, _mixQ, amount);
      }
      rig.setPoseRotation(bone, _local);
    }
  }

  toJSON(): Record<string, unknown> {
    return { type: 'aim', constraints: this.configs.map((c) => ({ ...c, referenceObject: typeof c.referenceObject === 'string' ? c.referenceObject : c.referenceObject?.name })) };
  }
}

export function resolveReference(rig: SkeletonRig, c: BoneConstraintConfig, out: Vector3): boolean {
  if (c.referenceType === 'bone') {
    const idx = rig.findBoneIndex(c.referenceBone ?? '');
    if (idx < 0) {
      rig.warnOnce(`aim-ref-missing:${c.referenceBone}`, `AimModifier: reference bone not found: ${c.referenceBone}`);
      return false;
    }
    rig.getGlobalPosePosition(idx, out);
    return true;
  }
  const obj = typeof c.referenceObject === 'string' ? rig.targetResolver?.(c.referenceObject) : c.referenceObject;
  if (!obj) {
    rig.warnOnce(`aim-ref-missing:${String(c.referenceObject)}`, `AimModifier: reference object not resolvable`);
    return false;
  }
  obj.getWorldPosition(out);
  rig.worldToRigSpace(out, out);
  return true;
}
