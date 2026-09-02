import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { ThreeIKError } from '../../core/errors';
import { getLocalPoseRotation, getProjectedNormal, getSwing, isZeroApprox, snapVectorToPlane, xformQuatInv } from '../../core/math';
import { vectorFromSecondaryDirection } from '../../core/bone-axes';
import type { BoneDirection, SecondaryDirection } from '../../core/bone-axes';
import { Modifier } from '../modifier';
import { getBoneAxis, type SolverInfo } from './ik-chain';

export interface TwoBoneIKConfig {
  rootBone: string;
  middleBone: string;
  endBone: string;
  target: Object3D | string;
  poleTarget: Object3D | string;
  /** 中骨局部空间里指向 pole 的轴向（用于 roll 修正）；'none' 跳过 roll 修正 */
  poleDirection?: SecondaryDirection;
  poleDirectionVector?: Vector3;
  extendEndBone?: boolean;
  endBoneDirection?: BoneDirection;
  endBoneLength?: number;
}

interface TwoBoneIKSetting {
  rootBone: number;
  middleBone: number;
  endBone: number;
  rootInfo: SolverInfo;
  midInfo: SolverInfo;
  cachedLengthSq: number;
  rootPos: Vector3;
  midPos: Vector3;
  endPos: Vector3;
  config: TwoBoneIKConfig;
}

// 模块临时量（一次性分配，求解热路径零分配）。占用约定（防别名冲突）：
// - resolveObj:                 _target/_targetPole 为输出槽；二者（尤其 _targetPole/poleDest）
//                               跨 processJoints 与 cacheCurrentJointRotations 全程只读存活，
//                               仅当前链迭代内有效，任何其他语句不得写
// - processJoints:              _v4(destination 副本) _v1(rootToDest/u) _v2(poleVec) _v3(detPlus)
//                               均在 cacheCurrentJointRotations 调用前消费完，之后可被覆写；
//                               末段写回用 _q1(root 新全局姿势) _q2(mid 局部姿势)
// - cacheCurrentJointRotations: swing 段 _v1(from/fromM) _v2(to/toM) _q1(swing)；
//                               _q3(rootGpose) 与 _qp(parentGpose) 跨全程（含 roll 段）存活
//   roll 段:                    _v1(poleDirLocal，k 计算后释放) _v2(poleDir，存活至 poleProj)
//                               _v5(a 全局 roll 轴) _v6(k 全局 pole 向量) 存活至 k2p；
//                               _v7(n 平面法线) 存活至 s2；
//                               _v8 逐语句 scratch（n 的叉积因子 / c0 / c1 / k 旋转后）；
//                               _q4 逐语句 scratch（setFromAxisAngle(a,t1/t2) 与 rootRoll⁻¹）；
//                               _v9(poleProj) _v10(k1p) _v11(k2p) 存活至 s1/s2；
//                               _q5(rootRoll) 存活至 mid 抵消，_q6(midRoll) 存活至最终乘算
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _v5 = new Vector3();
const _v6 = new Vector3();
const _v7 = new Vector3();
const _v8 = new Vector3();
const _v9 = new Vector3();
const _v10 = new Vector3();
const _v11 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _q4 = new Quaternion();
const _q5 = new Quaternion();
const _q6 = new Quaternion();
const _qp = new Quaternion();
const _target = new Vector3();
const _targetPole = new Vector3();

/**
 * Godot TwoBoneIK3D 的解析双骨求解器（pole target + roll 修正）。
 * v1 简化：middle 必须是 root 的直接子骨，end 必须是 middle 的直接子骨
 * （Godot 允许 root-mid / mid-end 之间夹骨，v1 不支持，attach 时校验）。
 */
export class TwoBoneIkModifier extends Modifier {
  private settings: TwoBoneIKSetting[] = [];

  constructor(private configs: TwoBoneIKConfig[]) {
    super();
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.settings = this.configs.map((config) => {
      const rootBone = rig.boneIndex(config.rootBone);
      const middleBone = rig.boneIndex(config.middleBone);
      const endBone = rig.boneIndex(config.endBone);
      if (rig.getParentIndex(middleBone) !== rootBone) {
        throw ThreeIKError.invalidChain(`TwoBoneIK: "${config.middleBone}" must be a direct child of "${config.rootBone}" (v1)`);
      }
      if (rig.getParentIndex(endBone) !== middleBone) {
        throw ThreeIKError.invalidChain(`TwoBoneIK: "${config.endBone}" must be a direct child of "${config.middleBone}" (v1)`);
      }
      // forward/length 取自子骨局部 rest 原点（与 IKChain.initJoints 同一约定）
      const rootInfo = makeInfo();
      const midInfo = makeInfo();
      rig.getRestPosition(middleBone, rootInfo.forwardVector);
      rootInfo.length = rootInfo.forwardVector.length();
      rootInfo.forwardVector.normalize();
      rig.getRestPosition(endBone, midInfo.forwardVector);
      midInfo.length = midInfo.forwardVector.length();
      midInfo.forwardVector.normalize();
      if (config.extendEndBone && (config.endBoneLength ?? 0) > 0) {
        // 虚拟端：mid 的长度替换为 endBone 轴向 * endBoneLength（求解以虚拟端点为目标）
        getBoneAxis(rig, endBone, config.endBoneDirection ?? 'from-parent', midInfo.forwardVector);
        midInfo.length = config.endBoneLength!;
      }
      if (isZeroApprox(rootInfo.length) || isZeroApprox(midInfo.length)) {
        throw ThreeIKError.invalidChain(`TwoBoneIK: zero-length bone in chain "${config.rootBone}"→"${config.endBone}"`);
      }
      const total = rootInfo.length + midInfo.length;
      return {
        rootBone, middleBone, endBone, rootInfo, midInfo,
        cachedLengthSq: total * total,
        rootPos: new Vector3(), midPos: new Vector3(), endPos: new Vector3(),
        config,
      };
    });
  }

  getSetting(i: number): Readonly<TwoBoneIKSetting> {
    return this.settings[i]!;
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const s of this.settings) {
      const destination = resolveObj(rig, s.config.target, _target);
      const poleDest = resolveObj(rig, s.config.poleTarget, _targetPole);
      if (!destination || !poleDest) continue;
      this.processJoints(rig, s, destination, poleDest);
    }
  }

  /** translate TwoBoneIK3D::_process_joints（two_bone_ik_3d.cpp 780–843 行） */
  private processJoints(rig: SkeletonRig, s: TwoBoneIKSetting, destinationIn: Vector3, poleDest: Vector3): void {
    const destination = _v4.copy(destinationIn);
    rig.getGlobalPosePosition(s.rootBone, s.rootPos);
    const rootToDest = _v1.copy(destination).sub(s.rootPos);
    if (isZeroApprox(rootToDest.lengthSq())) return;

    const rdLenSq = rootToDest.lengthSq();
    if (rdLenSq >= s.cachedLengthSq) {
      // 过远：拉直
      const rdNrm = rootToDest.normalize();
      s.midPos.copy(s.rootPos).addScaledVector(rdNrm, s.rootInfo.length);
      s.endPos.copy(s.midPos).addScaledVector(rdNrm, s.midInfo.length);
    } else {
      // 过近：推回可达球面
      const sub = s.rootInfo.length - s.midInfo.length;
      if (rdLenSq < sub * sub) {
        destination.copy(s.rootPos).addScaledVector(rootToDest.normalize(), Math.abs(sub));
        rootToDest.copy(destination).sub(s.rootPos);
      }
      s.endPos.copy(destination);

      // 余弦定理求两圆交点，pole 近者优先
      const lChain = rootToDest.length();
      const u = rootToDest.normalize(); // _v1 现为 u
      const poleVec = getProjectedNormal(s.rootPos, s.endPos, poleDest, _v2);
      if (isZeroApprox(poleVec.lengthSq())) return;
      const rRoot = s.rootInfo.length;
      const rMid = s.midInfo.length;
      const a = (lChain * lChain + rRoot * rRoot - rMid * rMid) / (2 * lChain);
      const h2 = Math.max(0, rRoot * rRoot - a * a);
      const h = Math.sqrt(h2);
      // det± = rootPos + u*a ± poleVec*h；取离 pole 近者
      const detPlus = _v3.copy(s.rootPos).addScaledVector(u, a).addScaledVector(poleVec, h);
      const detPlusDist = poleDest.distanceToSquared(detPlus);
      const detMinusDist = poleDest.distanceToSquared(s.midPos.copy(s.rootPos).addScaledVector(u, a).addScaledVector(poleVec, -h));
      if (detPlusDist <= detMinusDist) s.midPos.copy(detPlus);
    }

    this.cacheCurrentJointRotations(rig, s, poleDest);

    rig.setPoseRotation(s.rootBone, s.rootInfo.currentLpose);
    // mid 的局部姿势相对 root 当前全局姿势（Godot: get_local_pose_rotation）
    rig.getGlobalPoseQuaternion(s.rootBone, _q1); // root 已写入，全局姿势同步后读取
    getLocalPoseRotation(_q1, s.midInfo.currentGpose, _q2);
    rig.setPoseRotation(s.middleBone, _q2);
  }

  /** translate two_bone_ik_3d.h 146–235 行（含 pole roll 修正） */
  private cacheCurrentJointRotations(rig: SkeletonRig, s: TwoBoneIKSetting, poleDest: Vector3): void {
    const parent = rig.getParentIndex(s.rootBone);
    const parentGpose = _qp.identity(); // 专用临时，贯穿全程
    if (parent >= 0) rig.getGlobalPoseQuaternion(parent, parentGpose);

    // 更新 current vectors（全局单位向量：root→mid、mid→end）
    s.rootInfo.currentVector.copy(s.midPos).sub(s.rootPos).normalize();
    s.midInfo.currentVector.copy(s.endPos).sub(s.midPos).normalize();

    // root：lrest = 当前 pose 旋转；grest = parent * lrest；lpose = lrest * swing(fromTo(from, to), from)
    rig.getPoseRotation(s.rootBone, s.rootInfo.currentLrest);
    s.rootInfo.currentGrest.copy(parentGpose).multiply(s.rootInfo.currentLrest).normalize();
    const from = _v1.copy(s.rootInfo.forwardVector);
    const to = xformQuatInv(s.rootInfo.currentGrest, s.rootInfo.currentVector, _v2).normalize();
    _q1.setFromUnitVectors(from, to);
    getSwing(_q1, from, _q1);
    s.rootInfo.currentLpose.copy(s.rootInfo.currentLrest).multiply(_q1);
    s.rootInfo.currentGpose.copy(parentGpose).multiply(s.rootInfo.currentLpose).normalize();
    const rootGpose = _q3.copy(s.rootInfo.currentGpose); // 专用临时

    // mid（v1 直链：lrest = 当前 mid pose 旋转）
    rig.getPoseRotation(s.middleBone, s.midInfo.currentLrest);
    s.midInfo.currentGrest.copy(rootGpose).multiply(s.midInfo.currentLrest).normalize();
    const fromM = _v1.copy(s.midInfo.forwardVector);
    const toM = xformQuatInv(s.midInfo.currentGrest, s.midInfo.currentVector, _v2).normalize();
    _q1.setFromUnitVectors(fromM, toM);
    getSwing(_q1, fromM, _q1);
    s.midInfo.currentLpose.copy(s.midInfo.currentLrest).multiply(_q1);
    s.midInfo.currentGpose.copy(rootGpose).multiply(s.midInfo.currentLpose).normalize();

    // ---- roll 修正（poleDirection ≠ 'none' 时；求解热路径，零分配：全部走模块临时量）----
    const poleDirLocal = vectorFromSecondaryDirection(s.config.poleDirection ?? 'none', s.config.poleDirectionVector, _v1);
    if (isZeroApprox(poleDirLocal.lengthSq())) return;
    const poleDir = getProjectedNormal(s.rootPos, s.endPos, poleDest, _v2);
    if (isZeroApprox(poleDir.lengthSq())) return;
    const a = _v5.copy(s.midInfo.currentVector).normalize(); // 全局 roll 轴（mid forward）
    const k = _v6.copy(poleDirLocal).applyQuaternion(s.midInfo.currentGpose).normalize(); // 全局 pole 向量
    const n = _v7.copy(poleDir).cross(_v8.copy(s.midPos).sub(s.rootPos).normalize()).normalize(); // 全局平面法线
    if (isZeroApprox(a.lengthSq()) || isZeroApprox(k.lengthSq()) || isZeroApprox(n.lengthSq()) || isZeroApprox(n.dot(k))) return;

    // c0·cosθ + c1·sinθ + c2 = 0
    const c0 = n.dot(_v8.copy(k).addScaledVector(a, -k.dot(a))); // n·(k−a(k·a))
    const c1 = n.dot(_v8.copy(a).cross(k)); // n·(a×k)
    const c2 = n.dot(a) * k.dot(a); // (n·a)(k·a)
    const r = Math.sqrt(c0 * c0 + c1 * c1);
    if (isZeroApprox(r)) return;
    const phi = Math.atan2(c1, c0);
    const acosv = Math.acos(Math.min(1, Math.max(-1, -c2 / r)));
    const t1 = phi + acosv;
    const t2 = phi - acosv;
    // 两解取 pole 投影更近者
    const poleProj = snapVectorToPlane(n, poleDir, _v9).normalize();
    const k1p = snapVectorToPlane(n, _v8.copy(k).applyQuaternion(_q4.setFromAxisAngle(a, t1)), _v10).normalize();
    const k2p = snapVectorToPlane(n, _v8.copy(k).applyQuaternion(_q4.setFromAxisAngle(a, t2)), _v11).normalize();
    const s1 = isZeroApprox(poleProj.lengthSq()) ? Math.abs(t1) : k1p.dot(poleProj);
    const s2 = isZeroApprox(poleProj.lengthSq()) ? Math.abs(t2) : k2p.dot(poleProj);
    const t = s1 >= s2 ? t1 : t2;

    const rootRoll = _q5.setFromAxisAngle(s.rootInfo.forwardVector, t);
    const midRoll = _q6.setFromAxisAngle(s.midInfo.forwardVector, t);
    s.rootInfo.currentLpose.multiply(rootRoll);
    s.rootInfo.currentGpose.copy(parentGpose).multiply(s.rootInfo.currentLpose).normalize();
    rootGpose.copy(s.rootInfo.currentGpose);
    // mid 抵消 root 的 roll 后乘自身 roll（Godot: root_roll⁻¹ * mid_lpose * mid_roll）
    s.midInfo.currentLpose.premultiply(_q4.copy(rootRoll).invert()).multiply(midRoll);
    s.midInfo.currentGpose.copy(rootGpose).multiply(s.midInfo.currentLpose).normalize();
  }

  toJSON(): Record<string, unknown> {
    return {
      chains: this.configs.map((c) => ({
        ...c,
        target: typeof c.target === 'string' ? c.target : c.target.name || null,
        poleTarget: typeof c.poleTarget === 'string' ? c.poleTarget : c.poleTarget.name || null,
      })),
    };
  }
}

function makeInfo(): SolverInfo {
  return {
    currentLpose: new Quaternion(), currentLrest: new Quaternion(),
    currentGpose: new Quaternion(), currentGrest: new Quaternion(),
    currentVector: new Vector3(), forwardVector: new Vector3(), length: 0,
  };
}

/** 解析 Object3D 引用或 targetResolver 字符串 key，输出到 out（rig 空间） */
function resolveObj(rig: SkeletonRig, ref: Object3D | string, out: Vector3): Vector3 | null {
  const obj = typeof ref === 'string' ? rig.targetResolver?.(ref) : ref;
  if (!obj) {
    rig.warnOnce(`ik-target-missing:${String(ref)}`, `IK target not resolvable: ${String(ref)}`);
    return null;
  }
  obj.getWorldPosition(out);
  return rig.worldToRigSpace(out, out);
}
