import { Object3D, Vector3 } from 'three';
import { RootMotionModifier } from '../../modifiers/root-motion';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { DragTarget } from '../drag-target';
import { RotateRings } from '../rotate-rings';
import { toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface RootControlSpec extends ControlSpecBase {
  kind: 'root';
  /** rig 根骨名（髋）；非根骨会在 attach 时抛 CONFIG_ERROR */
  bone: string;
  /** 重心活动球域半径（默认 defaults.rootRadius）；锚 = 装配首解后骨骼世界位置的静态参照物 */
  radius?: number;
  /** 旋转通道（默认 false）：挂一副旋转环驱动根骨朝向（②髋朝向），随操纵器模式切换显示 */
  rotation?: boolean;
  /** 旋转环半径（默认 defaults.ringRadius） */
  ringRadius?: number;
}

export interface RootControlHandle extends ControlHandleBase {
  readonly kind: 'root';
  readonly target: DragTarget;
  readonly modifier: RootMotionModifier;
  /** 旋转环（spec.rotation: true 时存在） */
  readonly rings?: RotateRings;
  setRadius(radius: number): void;
}

/** 根骨（重心）控制点：RootMotionModifier + 固定锚点的活动球域。球本身不携带——它就是驱动源。
 *  rotation:true 时附加旋转环（CopyTransformModifier 只拷旋转），两种操纵器随模式切换 */
export function buildRootControl(ctx: ControlBuildContext, spec: RootControlSpec): BuiltControl {
  const bone = ctx.bone(spec.bone);
  const initial = spec.position ? toVec3(spec.position) : bone.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff3399, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);
  const modifier = new RootMotionModifier(spec.bone, target);

  let rings: RotateRings | undefined;
  const modifiers: BuiltControl['modifiers'] = [{ modifier, rootBone: spec.bone }];
  if (spec.rotation) {
    rings = new RotateRings({ ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius });
    rings.setJoint(bone);
    if (bone.parent) rings.setOrientationCarry(bone.parent); // FK 语义：相对骨架根携带（模型根旋转时跟随）
    ctx.scene.add(rings);
    // 只拷旋转：位置仍由 RootMotion/球驱动；同深度按声明顺序排在 RootMotion 之后
    modifiers.push({
      modifier: new CopyTransformModifier([{ applyBone: spec.bone, referenceType: 'object', referenceObject: rings, copyPosition: false, copyRotation: true }]),
      rootBone: spec.bone,
    });
  }

  let radius = spec.radius ?? ctx.defaults.rootRadius;
  const anchor = new Object3D(); // 静态锚：首解后捕获髋位，不随骨骼动
  const applyRadius = () => target.setReachConstraint(anchor, radius);

  const handle: RootControlHandle = {
    name: spec.name, kind: 'root', target, modifier, rings,
    setActive: (a) => { modifier.active = a; },
    setRadius: (r) => { radius = r; applyRadius(); },
  };

  return {
    name: spec.name, kind: 'root',
    targets: [target],
    rotateRings: rings ? [rings] : undefined,
    modifiers,
    postSolve() {
      bone.getWorldPosition(anchor.position);
      ctx.scene.add(anchor);
      applyRadius();
      rings?.update(); // 环心/朝向初始同步（装配首解后的姿势）
    },
    update() {
      rings?.update();
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      ctx.scene.remove(anchor);
      target.dispose();
      rings?.dispose();
    },
  };
}
