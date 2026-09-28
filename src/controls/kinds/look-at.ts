import { MathUtils, Quaternion, Vector3 } from 'three';
import { CCDIkModifier } from '../../modifiers/ik/ccd-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { DragTarget } from '../drag-target';
import { RotateRings } from '../rotate-rings';
import { resolveConeAxis, toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface LookAtControlSpec extends ControlSpecBase {
  kind: 'lookAt';
  /** CCD 链根（颈） */
  rootBone: string;
  /** CCD 链端（头） */
  endBone: string;
  /** 注视距离（锥 min=max，默认 defaults.lookAtRadius）：注视是纯方向语义，球恒贴脸前 R 处 */
  radius?: number;
  /** 方向锥半角（°，默认 defaults.lookAtAngleDeg）：防拖到脑后头反拧 */
  coneAngleDeg?: number;
  /** 锥轴，默认 'facing'（角色朝向） */
  coneAxis?: 'facing' | Vector3;
  /** 随 rootBone（颈）携带，默认 true */
  carry?: boolean;
  /** CCD 迭代数，默认 10 */
  maxIterations?: number;
  /** 凝视轴（端骨局部，默认按「rest 姿势下面部朝向 = 角色 facing」反推）：求解瞄准的是
   *  「端骨姿态 × 凝视轴」这条射线——面部追球；缺省推导对任何当前姿势都零跳动 */
  gazeAxis?: Vector3 | [number, number, number];
  /** 端骨旋转环的分摊比例（0–1）：>0 时本控制点变双通道——W 拖球（CCD 注视），
   *  E 出端骨环（拖环 = 端骨转 (1-share) + 父骨跟转 share，解剖学分节；头环带脖子）。
   *  分摊 modifier 只在环拖拽期间激活（常开会与 CCD 反馈互锁），按 endBone 深度排在自家
   *  CCD 之后（拖拽期间环赢）；松手即关闭，并自动把注视球摆回当前视线上——
   *  CCD 接手后保持拖拽朝向（绕注视轴的纯扭转 roll 球表达不了，松手后丢失） */
  rotateShare?: number;
}

export interface LookAtControlHandle extends ControlHandleBase {
  readonly kind: 'lookAt';
  readonly target: DragTarget;
  readonly modifier: CCDIkModifier;
  /** 端骨旋转环（rotateShare>0 时存在，否则 null） */
  readonly rings: RotateRings | null;
  setRadius(radius: number): void;
  setConeAngleDeg(deg: number): void;
}

/** 推导端骨局部凝视轴：rest 姿势下面部朝向 = 角色 facing。
 *  rest 全局朝向在 rig 空间,facing 是世界方向,中间隔着 rig 根骨之上(容器)的世界旋转,要换算 */
function deriveGazeAxisLocal(ctx: ControlBuildContext, endBone: string): Vector3 {
  const rig = ctx.rig;
  const restGlobal = rig.getGlobalRestQuaternion(rig.boneIndex(endBone), new Quaternion());
  const container = rig.getBoneAt(0).parent;
  const containerQuat = container ? container.getWorldQuaternion(new Quaternion()) : new Quaternion();
  const facingRig = ctx.facing.clone().applyQuaternion(containerQuat.invert()).normalize();
  return facingRig.applyQuaternion(restGlobal.invert()).normalize();
}

/** 当前视线上的球位（世界）:端骨世界位置 + 端骨世界姿态 × 凝视轴 × R */
function gazeBallPosition(endBoneObj: { getWorldQuaternion(q: Quaternion): Quaternion; getWorldPosition(v: Vector3): Vector3 }, gazeLocal: Vector3, radius: number): Vector3 {
  const gazeWorld = gazeLocal.clone().applyQuaternion(endBoneObj.getWorldQuaternion(new Quaternion()));
  return endBoneObj.getWorldPosition(new Vector3()).addScaledVector(gazeWorld, radius);
}

/** 注视（look-at）控制点：CCD 瞄准「端骨前方 R 处的虚拟凝视点」（extendEndBone 链端延伸）——
 *  面部追球,不是头骨轴指球。初始球缺省 = 当前视线上的点(头前 R 处),装配零跳动。
 *  rotateShare>0 时附端骨分摊旋转环，单控制点双通道（W 球 / E 环），松手自动重坐球 */
export function buildLookAtControl(ctx: ControlBuildContext, spec: LookAtControlSpec): BuiltControl {
  const rootBoneObj = ctx.bone(spec.rootBone);
  const endBoneObj = ctx.bone(spec.endBone);
  const share = spec.rotateShare ?? 0;
  const axis = resolveConeAxis(spec.coneAxis, ctx.facing);
  let radius = spec.radius ?? ctx.defaults.lookAtRadius;
  let angleDeg = spec.coneAngleDeg ?? ctx.defaults.lookAtAngleDeg;
  const gazeLocal = spec.gazeAxis
    ? toVec3(spec.gazeAxis).normalize()
    : deriveGazeAxisLocal(ctx, spec.endBone);
  const initial = spec.position
    ? toVec3(spec.position)
    : gazeBallPosition(endBoneObj, gazeLocal, radius);
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xffffff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);
  const chainConfig = () => [{
    rootBone: spec.rootBone,
    endBone: spec.endBone,
    target,
    // 虚拟凝视点:求解瞄准「端骨姿态 × 凝视轴 × R」的链端延伸,与球同距——视线对准即零误差。
    // endBoneLength 是 rig 空间长度:radius 是世界语义,容器带缩放(Y Bot 0.026)时必须换算,
    // 否则球(28 单位外)与凝视点(0.35)不同距,CCD 够不着把头拧去凑——进场即折头
    extendEndBone: true,
    endBoneDirection: 'custom' as const,
    endBoneDirectionVector: gazeLocal,
    endBoneLength: ctx.rig.worldToRigLength(radius),
  }];
  const modifier = new CCDIkModifier(chainConfig(), { maxIterations: spec.maxIterations ?? 10, angularDeltaLimit: Math.PI }); // 同 chain：π = 关闭逐帧转角预算

  // 锥锚 = 端骨(头):球恒在脸前 R 处;锚颈会让「当前视线上的球」被钳离球面、次帧回拉
  const applyCone = () => target.setConeConstraint(endBoneObj, axis, MathUtils.degToRad(angleDeg), radius, radius);

  // ---- 旋转通道（rotateShare>0）：端骨分摊环。gating 与重坐全内聚——控制点自持球与骨 ----
  let rings: RotateRings | null = null;
  let shareModifier: CopyTransformModifier | null = null;
  if (share > 0) {
    rings = new RotateRings({ ringRadius: ctx.defaults.ringRadius, viewRing: false }); // 视角环不发 onDragStart，gating 不激活，隐藏
    rings.setJoint(endBoneObj);
    // 不设 orientationCarry：非拖拽时镜像端骨求解朝向（分摊模式语义，见 bone kind）
    ctx.scene.add(rings);
    shareModifier = new CopyTransformModifier([{
      applyBone: spec.endBone, referenceType: 'object', referenceObject: rings, copyRotation: true, parentShare: share,
    }]);
    shareModifier.active = false; // 只在拖拽期间激活——常开则「环镜像求解结果 + 回写」反馈互锁，CCD 被钉死
    const sm = shareModifier;
    rings.onDragStart = () => {
      sm.active = true;
    };
    rings.onDragEnd = () => {
      sm.active = false;
      // 注视球重坐:摆回当前视线(头前 R 处),过锥钳制管线。
      // 不重坐则 modifier 一关,CCD 下帧把端骨拉回旧球位
      target.moveTo(gazeBallPosition(endBoneObj, gazeLocal, radius));
    };
  }

  const handle: LookAtControlHandle = {
    name: spec.name, kind: 'lookAt', target, modifier, rings,
    setActive: (a) => { modifier.active = a; },
    setRadius: (r) => { radius = r; applyCone(); modifier.setChains(chainConfig()); },
    setConeAngleDeg: (d) => { angleDeg = d; applyCone(); },
  };

  return {
    name: spec.name, kind: 'lookAt',
    targets: [target],
    moveTargets: [target],
    rotateRings: rings ? [rings] : [],
    // CCD 按 rootBone 深度、分摊 modifier 按 endBone 深度——天然排在自家 CCD 之后（拖拽期间环赢）
    modifiers: shareModifier
      ? [{ modifier, rootBone: spec.rootBone }, { modifier: shareModifier, rootBone: spec.endBone }]
      : [{ modifier, rootBone: spec.rootBone }],
    postSolve() {
      applyCone();
      if (spec.carry !== false) target.setCarry(rootBoneObj);
      rings?.update(); // 环初始镜像求解后朝向（分摊基准确立）
    },
    update() {
      rings?.update();
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
      rings?.dispose();
    },
  };
}
