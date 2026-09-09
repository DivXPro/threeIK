import { MathUtils, Vector3 } from 'three';
import { CCDIkModifier } from '../../modifiers/ik/ccd-ik';
import { DragTarget } from '../drag-target';
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
}

export interface LookAtControlHandle extends ControlHandleBase {
  readonly kind: 'lookAt';
  readonly target: DragTarget;
  readonly modifier: CCDIkModifier;
  setRadius(radius: number): void;
  setConeAngleDeg(deg: number): void;
}

/** 注视（look-at）控制点：CCD + 恒距方向锥。初始位置缺省 = 颈 + 锥轴×半径（正前方平视） */
export function buildLookAtControl(ctx: ControlBuildContext, spec: LookAtControlSpec): BuiltControl {
  const rootBoneObj = ctx.bone(spec.rootBone);
  const axis = resolveConeAxis(spec.coneAxis, ctx.facing);
  let radius = spec.radius ?? ctx.defaults.lookAtRadius;
  let angleDeg = spec.coneAngleDeg ?? ctx.defaults.lookAtAngleDeg;
  const initial = spec.position
    ? toVec3(spec.position)
    : rootBoneObj.getWorldPosition(new Vector3()).addScaledVector(axis, radius);
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xffffff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.setAxisHandles(true); // 移动操纵器 Maya 化：轴箭头+中心球
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);
  const modifier = new CCDIkModifier(
    [{ rootBone: spec.rootBone, endBone: spec.endBone, target }],
    { maxIterations: spec.maxIterations ?? 10, angularDeltaLimit: Math.PI }, // 同 chain：π = 关闭逐帧转角预算
  );

  const applyCone = () => target.setConeConstraint(rootBoneObj, axis, MathUtils.degToRad(angleDeg), radius, radius);

  const handle: LookAtControlHandle = {
    name: spec.name, kind: 'lookAt', target, modifier,
    setActive: (a) => { modifier.active = a; },
    setRadius: (r) => { radius = r; applyCone(); },
    setConeAngleDeg: (d) => { angleDeg = d; applyCone(); },
  };

  return {
    name: spec.name, kind: 'lookAt',
    targets: [target],
    modifiers: [{ modifier, rootBone: spec.rootBone }],
    postSolve() {
      applyCone();
      if (spec.carry !== false) target.setCarry(rootBoneObj);
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
    },
  };
}
