import { Vector3 } from 'three';
import { RotateRings } from '../rotate-rings';
import { DragTarget, MARKER_SCALE } from '../drag-target';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import type { BuiltControl, ControlBuildContext, ControlHandleBase, ControlSpecBase } from '../types';

export interface BoneControlSpec extends ControlSpecBase {
  kind: 'bone';
  /** 要直接掰的骨头 */
  bone: string;
  /** 标记球（选中入口）跟随的骨，缺省 = bone 本身。关节挤在一起时分流用——
   *  如肩部掰的是锁骨（靠脖子根），标记球挂到大臂骨根部（肩膀头）才好找好点 */
  markerBone?: string;
  /** 旋转环半径（默认 defaults.ringRadius）；胸口这类大关节可以加大 */
  ringRadius?: number;
}

export interface BoneControlHandle extends ControlHandleBase {
  readonly kind: 'bone';
  readonly modifier: CopyTransformModifier;
  readonly rings: RotateRings;
  /** 关节处的小标记球（纯选中入口，不可拖；两种模式都常驻） */
  readonly marker: DragTarget;
}

/** 直接掰骨（FK 旋转）：一副旋转环绑在指定骨头上，拖环 = 转这根骨（CopyTransform 只拷旋转）。
 *  用于胸口/脖子/肩膀/脚尖这类「不是 IK 链、也不需要位置球」的关节——HumanIK 里
 *  Spine 顶节/Neck/Shoulder/ToeBase 的对应物。旋转专用：关节上常驻一颗小标记球作为选中入口
 *  （点击 = 选中），选中即出环、不看 W/E——它在 W 模式没有别的操纵器可显示。
 *  排序即语义：modifier 按骨深度排队——胸口环在脊柱 FABRIK 之后生效（弯腰之上再拧上半身），
 *  肩膀环在手臂 TwoBone 之前（送肩后手球仍钉住）；与链同深度时按声明顺序（如脖子环要声明在
 *  头部注视之前，让 CCD 随后把头重新瞄准）。 */
export function buildBoneControl(ctx: ControlBuildContext, spec: BoneControlSpec): BuiltControl {
  const bone = ctx.bone(spec.bone);
  const markerBone = spec.markerBone ? ctx.bone(spec.markerBone) : bone;
  const marker = new DragTarget(ctx.camera, ctx.dom, markerBone.getWorldPosition(new Vector3()), spec.color ?? 0x88ddff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  marker.setMarkerMode(true); // 永远是标记：不可拖，点击 = 选中
  marker.ball.scale.setScalar(MARKER_SCALE); // 常驻标记身份：比可拖球小一号（大小此后不再变）
  marker.onPress = () => ctx.select(spec.name);
  ctx.scene.add(marker);

  const rings = new RotateRings(ctx.camera, ctx.dom, {
    ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius,
    dragControl: ctx.dragControl,
  });
  rings.setJoint(bone);
  if (bone.parent) rings.setOrientationCarry(bone.parent); // FK 语义：相对父骨携带（弯腰时胸口/脖子跟着相对转）
  rings.onPress = () => ctx.select(spec.name);
  ctx.scene.add(rings);

  const modifier = new CopyTransformModifier([{
    applyBone: spec.bone, referenceType: 'object', referenceObject: rings, copyPosition: false, copyRotation: true,
  }]);

  const handle: BoneControlHandle = {
    name: spec.name, kind: 'bone', modifier, rings, marker,
    setActive: (a) => { modifier.active = a; },
  };

  return {
    name: spec.name, kind: 'bone',
    targets: [marker], // 标记球常驻两种模式（applyView 经 moveTargets 跳过它，不随切换改样式）
    moveTargets: [],
    rotateRings: [rings],
    rotationOnly: true, // 纯旋转控制点：选中即出环，不看 W/E（W 模式没有别的操纵器可显示）
    modifiers: [{ modifier, rootBone: spec.bone }],
    postSolve() {
      // 先归位再携带：构造时按 rest 摆位，装配首解可能已把姿势搬离 rest（如 hips 球拉回身高），
      // 不归位会把「rest 与首解的差」当携带偏移一直留着（标记球偏离关节几厘米）
      marker.moveTo(markerBone.getWorldPosition(new Vector3()));
      marker.setCarry(markerBone); // 跟随标记骨（别的控制点挪动骨头后标记一起动）
      rings.update(); // 环心/朝向初始同步（装配首解后的姿势）
    },
    update() {
      rings.update();
    },
    handle,
    dispose() {
      ctx.scene.remove(marker);
      marker.dispose();
      rings.dispose();
    },
  };
}
