import { Object3D, Vector3 } from 'three';
import { RootMotionModifier } from '../../modifiers/root-motion';
import { DragTarget } from '../drag-target';
import { toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface RootControlSpec extends ControlSpecBase {
  kind: 'root';
  /** rig 根骨名（髋）；非根骨会在 attach 时抛 CONFIG_ERROR */
  bone: string;
  /** 重心活动球域半径（默认 defaults.rootRadius）；锚 = 装配首解后骨骼世界位置的静态参照物 */
  radius?: number;
}

export interface RootControlHandle extends ControlHandleBase {
  readonly kind: 'root';
  readonly modifier: RootMotionModifier;
  setRadius(radius: number): void;
}

/** 根骨（重心）控制点：RootMotionModifier + 固定锚点的活动球域。球本身不携带——它就是驱动源 */
export function buildRootControl(ctx: ControlBuildContext, spec: RootControlSpec): BuiltControl {
  const bone = ctx.bone(spec.bone);
  const initial = spec.position ? toVec3(spec.position) : bone.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff3399, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  ctx.scene.add(target);
  const modifier = new RootMotionModifier(spec.bone, target);

  let radius = spec.radius ?? ctx.defaults.rootRadius;
  const anchor = new Object3D(); // 静态锚：首解后捕获髋位，不随骨骼动
  const applyRadius = () => target.setReachConstraint(anchor, radius);

  const handle: RootControlHandle = {
    name: spec.name, kind: 'root', target, modifier,
    setActive: (a) => { modifier.active = a; },
    setRadius: (r) => { radius = r; applyRadius(); },
  };

  return {
    name: spec.name, kind: 'root',
    targets: [target],
    modifiers: [{ modifier, rootBone: spec.bone }],
    postSolve() {
      bone.getWorldPosition(anchor.position);
      ctx.scene.add(anchor);
      applyRadius();
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      ctx.scene.remove(anchor);
      target.dispose();
    },
  };
}
