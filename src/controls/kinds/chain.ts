import { Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { FabrikModifier } from '../../modifiers/ik/fabrik';
import { DragTarget } from '../drag-target';
import { measureChain } from '../measure-chain';
import { toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface ChainControlSpec extends ControlSpecBase {
  kind: 'chain';
  rootBone: string;
  endBone: string;
  /** 可达半径倍率（默认 defaults.reachScale） */
  reachScale?: number;
  /** 端球随 rootBone 携带，默认 true；钉地的脚/钉墙的手设 false */
  carry?: boolean;
  /** FABRIK 迭代数，默认 10 */
  maxIterations?: number;
}

export interface ChainControlHandle extends ControlHandleBase {
  readonly kind: 'chain';
  readonly modifier: FabrikModifier;
  /** 实测链可达半径（米，世界空间） */
  readonly reach: number;
  setReachScale(scale: number): void;
}

/** 多骨链（FABRIK）控制点：端球硬钳制在链可达半径内。
 *  angularDeltaLimit=π 是固化结论：update 每帧从 base 重播种（等价 Godot deterministic），
 *  2°/迭代默认值会把每帧转角预算卡死——离 rest 远的 target 永远到不了 */
export function buildChainControl(ctx: ControlBuildContext, spec: ChainControlSpec): BuiltControl {
  const rootBoneObj = ctx.bone(spec.rootBone);
  const endBoneObj = ctx.bone(spec.endBone);
  const initial = spec.position ? toVec3(spec.position) : endBoneObj.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xcc66ff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.setAxisHandles(true); // 移动操纵器 Maya 化：轴箭头+中心球
  ctx.scene.add(target);
  const modifier = new FabrikModifier(
    [{ rootBone: spec.rootBone, endBone: spec.endBone, target }],
    { maxIterations: spec.maxIterations ?? 10, angularDeltaLimit: Math.PI },
  );

  let reachScale = spec.reachScale ?? ctx.defaults.reachScale;
  let reach = 0;
  const applyReach = () => {
    if (reach > 0) target.setReachConstraint(rootBoneObj, reach * reachScale);
  };

  const handle: ChainControlHandle = {
    name: spec.name, kind: 'chain', target, modifier,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
  };

  return {
    name: spec.name, kind: 'chain',
    targets: [target],
    modifiers: [{ modifier, rootBone: spec.rootBone }],
    postSolve() {
      const m = measureChain(rootBoneObj, spec.rootBone, spec.endBone);
      if (!m) throw ThreeIKError.configError(`chain 控制点 "${spec.name}": ${spec.rootBone}→${spec.endBone} 不是直系链`);
      reach = m.reach;
      applyReach();
      if (spec.carry !== false) target.setCarry(rootBoneObj);
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
    },
  };
}
