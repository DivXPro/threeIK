import { Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { Modifier } from '../modifier';
import type { BoneConstraintConfig } from './aim';

export interface CopyTransformConfig extends BoneConstraintConfig {
  copyPosition?: boolean;
  copyRotation?: boolean;
  copyScale?: boolean;
  /** 旋转分摊（0–1，缺省 0 = 不分摊）：把「期望 vs 当前」的世界旋转增量先按此比例分给父骨，
   *  本骨补足剩余——本骨最终世界朝向恒等于期望（任意角度精确，非近似）。头环带脖子这类
   *  「端骨操控、父骨分节」的解剖学旋转用。增量基准 = 本 modifier 运行前的当前全局姿势
   *  （管线每帧从 base 重解，基准即「无本控制时」的姿势）。与 amount<1 不组合（分摊路径全量） */
  parentShare?: number;
}

// 模块临时量（一次性分配，processModification 热路径零分配）。单次迭代内占用约定：
// - _parentG/_parentPos: 父骨全局旋转/位置，迭代开头写入。_parentG 先被 copyRot 非破坏性消费
//   （_local.copy(_parentG).invert()），后被 copyPos 就地反转消费（applyQuaternion(_parentG.invert())）——
//   此后本迭代禁止再读 _parentG（下轮迭代开头重写）
// - _q:        参考全局旋转（bone 分支）/ rig 空间旋转（object 分支）；消费于 _local.multiply(_q) 后死亡，
//              amount<1 时复用该槽作 getPoseRotation 的输出（slerp 的 qa）
// - _local:    object 分支先作 parentObj 世界四元数 scratch（premultiply 段，invert 后随即被覆写）；
//              之后为目标局部旋转 → setPoseRotation 写出
// - _mixQ:     amount 混合中转（裁决1：slerpQuaternions 的 qb 不得与 this 同参）
// - _pos:      期望局部位置 → setPosePosition 写出
// - _srcPos:   amount<1 时当前局部位置（lerp 的 prev 端；裁决2：替代 brief 的 _src = new Object3D()）
const _pos = new Vector3();
const _parentPos = new Vector3();
const _srcPos = new Vector3();
const _q = new Quaternion();
const _parentG = new Quaternion();
const _local = new Quaternion();
const _mixQ = new Quaternion();
// parentShare 分摊专用槽（applySharedRotation 内自包含，与上方单次迭代占用约定不交叉）：
// _curW 先作本骨当前世界（求增量 D），随即复用为父骨当前世界/父骨目标局部；_dWorld 增量；
// _shareW 父骨目标世界；_gpW 祖父世界（父骨局部换算用）
const _curW = new Quaternion();
const _dWorld = new Quaternion();
const _shareW = new Quaternion();
const _gpW = new Quaternion();

export class CopyTransformModifier extends Modifier {
  constructor(private configs: CopyTransformConfig[]) {
    super();
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const c of this.configs) {
      const bone = rig.boneIndex(c.applyBone);
      const amount = c.amount ?? 1;
      const parentShare = c.parentShare ?? 0;
      const copyPos = c.copyPosition ?? false;
      const copyRot = c.copyRotation ?? true;
      if (c.copyScale) rig.warnOnce('copy-scale-unsupported', 'CopyTransformModifier: global scale copy is not supported in v1 (ignored)');

      const parent = rig.getParentIndex(bone);
      if (parent >= 0) {
        rig.getGlobalPoseQuaternion(parent, _parentG);
        rig.getGlobalPosePosition(parent, _parentPos);
      } else {
        _parentG.identity();
        _parentPos.set(0, 0, 0);
      }

      if (c.referenceType === 'bone') {
        const src = rig.findBoneIndex(c.referenceBone ?? '');
        if (src < 0) {
          rig.warnOnce(`copy-ref-missing:${c.referenceBone}`, `CopyTransformModifier: reference bone not found: ${c.referenceBone}`);
          continue;
        }
        if (copyRot) {
          rig.getGlobalPoseQuaternion(src, _q);
          if (parentShare > 0 && parent >= 0) {
            this.applySharedRotation(rig, bone, parent, _q, parentShare);
          } else {
            _local.copy(_parentG).invert().multiply(_q).normalize();
            if (amount < 1) {
              // 裁决1：slerpQuaternions 的 qb 不得与 this 同参（见 aim.ts 注释），经 _mixQ 中转
              rig.getPoseRotation(bone, _q);
              _mixQ.copy(_local);
              _local.slerpQuaternions(_q, _mixQ, amount);
            }
            rig.setPoseRotation(bone, _local);
          }
        }
        if (copyPos) {
          rig.getGlobalPosePosition(src, _pos);
          _pos.sub(_parentPos).applyQuaternion(_parentG.invert());
          if (amount < 1) {
            // 偏差3：混合方向修正为 prev → desired（brief 原文 _pos.lerp(prev, amount) 方向相反：
            // amount=1 时结果为 prev 即零效果，与本文件旋转路径/Aim/管线 blendWorkPose 的
            // 「weight=1 = 全量生效」约定矛盾）。_pos 保持 desired，结果写回 _pos。
            rig.getPosePosition(bone, _srcPos);
            _srcPos.lerp(_pos, amount);
            _pos.copy(_srcPos);
          }
          rig.setPosePosition(bone, _pos);
        }
      } else {
        const obj = typeof c.referenceObject === 'string' ? rig.targetResolver?.(c.referenceObject) : c.referenceObject;
        if (!obj) {
          rig.warnOnce(`copy-ref-missing:${String(c.referenceObject)}`, 'CopyTransformModifier: reference object not resolvable');
          continue;
        }
        obj.updateWorldMatrix(true, false);
        if (copyRot) {
          obj.getWorldQuaternion(_q); // 世界 → rig 空间
          if (Number.isNaN(_q.x + _q.y + _q.z + _q.w)) {
            rig.warnOnce(`copy-ref-nan:${String(c.referenceObject)}`, 'CopyTransformModifier: reference object quaternion is NaN');
            continue;
          }
          const parentObj = rig.getBoneAt(0).parent;
          if (parentObj) {
            parentObj.updateWorldMatrix(true, false);
            parentObj.getWorldQuaternion(_local);
            _q.premultiply(_local.invert());
          }
          if (parentShare > 0 && parent >= 0) {
            this.applySharedRotation(rig, bone, parent, _q, parentShare);
          } else {
            _local.copy(_parentG).invert().multiply(_q).normalize();
            if (amount < 1) {
              // 裁决1：同参缺陷修复，同 bone 分支
              rig.getPoseRotation(bone, _q);
              _mixQ.copy(_local);
              _local.slerpQuaternions(_q, _mixQ, amount);
            }
            rig.setPoseRotation(bone, _local);
          }
        }
        if (copyPos) {
          obj.getWorldPosition(_pos);
          if (Number.isNaN(_pos.x + _pos.y + _pos.z)) {
            rig.warnOnce(`copy-ref-nan:${String(c.referenceObject)}`, 'CopyTransformModifier: reference object position is NaN');
            continue;
          }
          rig.worldToRigSpace(_pos, _pos);
          _pos.sub(_parentPos).applyQuaternion(_parentG.invert());
          if (amount < 1) {
            // 偏差3：同 bone 分支
            rig.getPosePosition(bone, _srcPos);
            _srcPos.lerp(_pos, amount);
            _pos.copy(_srcPos);
          }
          rig.setPosePosition(bone, _pos);
        }
      }
    }
  }

  /** parentShare 分摊写入：增量 D = desired × 当前⁻¹（世界），父骨先吃 slerp(I, D, share) 份，
   *  本骨补足剩余——本骨最终世界朝向恒等于 desired（shareW × 本骨局部 = desired，任意角度精确）。
   *  desiredWorld 为 rig 空间；全部解析计算，写出前不回读 rig（写父骨后全局缓存已变） */
  private applySharedRotation(rig: SkeletonRig, bone: number, parent: number, desiredWorld: Quaternion, share: number): void {
    rig.getGlobalPoseQuaternion(bone, _curW);
    _dWorld.copy(_curW).invert().premultiply(desiredWorld); // D = desired × cur⁻¹
    rig.getGlobalPoseQuaternion(parent, _curW);             // 复用槽：父骨当前世界
    _shareW.identity().slerp(_dWorld, share).multiply(_curW); // 父骨目标世界 = slerp(I, D, share) × 父骨当前
    const gp = rig.getParentIndex(parent);
    if (gp >= 0) rig.getGlobalPoseQuaternion(gp, _gpW);
    else _gpW.identity();
    _curW.copy(_gpW).invert().multiply(_shareW).normalize(); // 父骨目标局部
    rig.setPoseRotation(parent, _curW);
    _local.copy(_shareW).invert().multiply(desiredWorld).normalize(); // 本骨局部 = 父骨目标世界⁻¹ × desired
    rig.setPoseRotation(bone, _local);
  }

  toJSON(): Record<string, unknown> {
    return { type: 'copy-transform', constraints: this.configs.map((c) => ({ ...c, referenceObject: typeof c.referenceObject === 'string' ? c.referenceObject : c.referenceObject?.name })) };
  }
}
