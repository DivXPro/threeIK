import { RotateRings } from '../rotate-rings';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import type { BuiltControl, ControlBuildContext, ControlHandleBase, ControlSpecBase } from '../types';

export interface BoneControlSpec extends ControlSpecBase {
  kind: 'bone';
  /** 要直接掰的骨头 */
  bone: string;
  /** 旋转环半径（默认 defaults.ringRadius）；胸口这类大关节可以加大 */
  ringRadius?: number;
}

export interface BoneControlHandle extends ControlHandleBase {
  readonly kind: 'bone';
  readonly modifier: CopyTransformModifier;
  readonly rings: RotateRings;
}

/** 直接掰骨（FK 旋转）：一副旋转环绑在指定骨头上，拖环 = 转这根骨（CopyTransform 只拷旋转）。
 *  用于胸口/脖子/肩膀/脚尖这类「不是 IK 链、也不需要位置球」的关节——HumanIK 里
 *  Spine 顶节/Neck/Shoulder/ToeBase 的对应物。旋转专用：只在 rotate 模式（E）显示。
 *  排序即语义：modifier 按骨深度排队——胸口环在脊柱 FABRIK 之后生效（弯腰之上再拧上半身），
 *  肩膀环在手臂 TwoBone 之前（送肩后手球仍钉住）；与链同深度时按声明顺序（如脖子环要声明在
 *  头部注视之前，让 CCD 随后把头重新瞄准）。 */
export function buildBoneControl(ctx: ControlBuildContext, spec: BoneControlSpec): BuiltControl {
  const bone = ctx.bone(spec.bone);
  const rings = new RotateRings(ctx.camera, ctx.dom, {
    ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius,
    dragControl: ctx.dragControl,
  });
  rings.setJoint(bone);
  ctx.scene.add(rings);

  const modifier = new CopyTransformModifier([{
    applyBone: spec.bone, referenceType: 'object', referenceObject: rings, copyPosition: false, copyRotation: true,
  }]);

  const handle: BoneControlHandle = {
    name: spec.name, kind: 'bone', modifier, rings,
    setActive: (a) => { modifier.active = a; },
  };

  return {
    name: spec.name, kind: 'bone',
    targets: [], // 旋转专用：没有位置球；move 模式（W）下什么都不显示
    rotateRings: [rings],
    modifiers: [{ modifier, rootBone: spec.bone }],
    postSolve() {
      rings.update(); // 环心/朝向初始同步（装配首解后的姿势）
    },
    update() {
      rings.update();
    },
    handle,
    dispose() {
      rings.dispose();
    },
  };
}
