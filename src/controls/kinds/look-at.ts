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
  /** 恒距半径（锥 min=max，默认 defaults.lookAtRadius）：注视是纯方向语义，球恒贴颈前 R 处 */
  radius?: number;
  /** 方向锥半角（°，默认 defaults.lookAtAngleDeg）：防拖到脑后头反拧 */
  coneAngleDeg?: number;
  /** 锥轴，默认 'facing'（角色朝向） */
  coneAxis?: 'facing' | Vector3;
  /** 随 rootBone（颈）携带，默认 true */
  carry?: boolean;
  /** CCD 迭代数，默认 10 */
  maxIterations?: number;
  /** 端骨旋转环的分摊比例（0–1）：>0 时本控制点变双通道——W 拖球（CCD 注视），
   *  E 出端骨环（拖环 = 端骨转 (1-share) + 父骨跟转 share，解剖学分节；头环带脖子）。
   *  分摊 modifier 只在环拖拽期间激活（常开会与 CCD 反馈互锁），按 endBone 深度排在自家
   *  CCD 之后（拖拽期间环赢）；松手即关闭，并自动把注视球绕颈根按拖拽增量重坐——
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

/** 注视（look-at）控制点：CCD + 恒距方向锥。初始位置缺省 = 颈 + 锥轴×半径（正前方平视）。
 *  rotateShare>0 时附端骨分摊旋转环，单控制点双通道（W 球 / E 环），松手自动重坐球 */
export function buildLookAtControl(ctx: ControlBuildContext, spec: LookAtControlSpec): BuiltControl {
  const rootBoneObj = ctx.bone(spec.rootBone);
  const endBoneObj = ctx.bone(spec.endBone);
  const share = spec.rotateShare ?? 0;
  const axis = resolveConeAxis(spec.coneAxis, ctx.facing);
  let radius = spec.radius ?? ctx.defaults.lookAtRadius;
  let angleDeg = spec.coneAngleDeg ?? ctx.defaults.lookAtAngleDeg;
  const initial = spec.position
    ? toVec3(spec.position)
    : rootBoneObj.getWorldPosition(new Vector3()).addScaledVector(axis, radius);
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xffffff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);
  const modifier = new CCDIkModifier(
    [{ rootBone: spec.rootBone, endBone: spec.endBone, target }],
    { maxIterations: spec.maxIterations ?? 10, angularDeltaLimit: Math.PI }, // 同 chain：π = 关闭逐帧转角预算
  );

  const applyCone = () => target.setConeConstraint(rootBoneObj, axis, MathUtils.degToRad(angleDeg), radius, radius);

  // ---- 旋转通道（rotateShare>0）：端骨分摊环。gating 与重坐全内聚——控制点自持球与骨 ----
  let rings: RotateRings | null = null;
  let shareModifier: CopyTransformModifier | null = null;
  const dragStartQuat = new Quaternion(); // 环拖拽开始时的端骨世界朝向快照（重坐基准）
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
      endBoneObj.getWorldQuaternion(dragStartQuat);
    };
    rings.onDragEnd = () => {
      sm.active = false;
      // 注视球重坐：球绕颈根施加同样的世界增量 D = now × before⁻¹（过锥钳制管线）。
      // 不重坐则 modifier 一关，CCD 下帧把端骨拉回旧球位；不能按「颈→端骨原点」重坐——
      // 端骨原点在转轴上，纯 yaw 时方向不变（球原地重坐 = 松手回弹）
      const dq = endBoneObj.getWorldQuaternion(new Quaternion()).multiply(dragStartQuat.invert());
      const neckPos = rootBoneObj.getWorldPosition(new Vector3());
      const ballPos = target.getWorldPosition(new Vector3());
      target.moveTo(ballPos.sub(neckPos).applyQuaternion(dq).add(neckPos));
    };
  }

  const handle: LookAtControlHandle = {
    name: spec.name, kind: 'lookAt', target, modifier, rings,
    setActive: (a) => { modifier.active = a; },
    setRadius: (r) => { radius = r; applyCone(); },
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
