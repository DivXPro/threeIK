import { Quaternion, Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { TwoBoneIkModifier } from '../../modifiers/ik/two-bone-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { DragTarget } from '../drag-target';
import { PoleOrbit } from '../pole-orbit';
import { RotateRings } from '../rotate-rings';
import { PoleGuide } from '../guides';
import { measureChain } from '../measure-chain';
import { toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface LimbPoleSpec {
  color?: number;
  /** 初始方向提示（世界坐标，投影到轨道面后作为球的初始方向）；缺省 = 中骨关节 + 角色朝向×半径 */
  position?: Vector3 | [number, number, number];
  /** 轨道半径 = 球到肘/膝的固定距离（默认 defaults.poleRadius） */
  radius?: number;
  /** pole↔关节引导线，默认 true */
  guide?: boolean;
}

export interface LimbControlSpec extends ControlSpecBase {
  kind: 'limb';
  rootBone: string;
  middleBone: string;
  endBone: string;
  /** 端球可达半径倍率（默认 defaults.reachScale） */
  reachScale?: number;
  /** pole 保活伸展上限（默认 defaults.poleKeepAlive）：完全伸直时 pole 几何失效（解集退化成点），
   *  96% 处留回旋空间让 pole 永远活着，肉眼读作"伸直"；设为 1 可体验退化点 */
  keepAlive?: number;
  /** 端球随 rootBone 携带，默认 true；钉地的脚设 false */
  carry?: boolean;
  /** pole 球；整体缺省时按默认参数自动摆位 */
  pole?: LimbPoleSpec;
  /** roll 修正（拉直后 pole 仍驱动中骨扭转，Godot pole_direction）：
   *  'auto'（默认）按首解后姿势实测「正指向 pole 的中骨局部轴」，开启瞬间修正量≈0 零跳变；
   *  'none' 关闭 */
  poleDirection?: 'auto' | 'none';
  /** 端骨旋转通道（默认 false）：端骨关节挂一副旋转环驱动端骨朝向（①脚朝向/手腕翻向），
   *  随操纵器模式切换显示（rotate 模式下端球隐藏、换环上场） */
  endRotation?: boolean;
  /** 旋转环半径（默认 defaults.ringRadius） */
  ringRadius?: number;
}

export interface LimbControlHandle extends ControlHandleBase {
  readonly kind: 'limb';
  readonly target: DragTarget;
  readonly modifier: TwoBoneIkModifier;
  /** pole 轨道球（定长绕链轴转；纯位置控制点，两种模式都常驻可用） */
  readonly pole: PoleOrbit;
  /** 端骨旋转环（spec.endRotation: true 时存在） */
  readonly rings?: RotateRings;
  /** 实测链可达半径（米，世界空间，未经 keepAlive 收缩） */
  readonly reach: number;
  setReachScale(scale: number): void;
  setKeepAlive(k: number): void;
  setPoleRadius(radius: number): void;
  setGuideVisible(visible: boolean): void;
}

// A 段（poleDirection 实测）临时量
const _rootPos = new Vector3();
const _endPos = new Vector3();
const _midPos = new Vector3();
const _polePos = new Vector3();
const _midQ = new Quaternion();

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制，弯度由它离根的远近决定——Maya 同款语义）
 *  + pole 轨道球（球以定长绕「根→端」链轴转，正是肘/膝能转的轨迹；拖球沿轨道滑 = 调朝向，
 *  不管弯度；引导线即「固定长度」的可视化）+ 引导线。pole 是纯位置控制点，不参与 W/E 切换，
 *  两种模式都常驻。内置 roll 修正实测（A）。 */
export function buildLimbControl(ctx: ControlBuildContext, spec: LimbControlSpec): BuiltControl {
  const rootObj = ctx.bone(spec.rootBone);
  const midObj = ctx.bone(spec.middleBone);
  const endObj = ctx.bone(spec.endBone);

  const initial = spec.position ? toVec3(spec.position) : endObj.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff5533, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.setAxisHandles(true); // 移动操纵器 Maya 化：轴箭头+中心球（选中后显示）
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);

  const poleRadius = spec.pole?.radius ?? ctx.defaults.poleRadius;
  const pole = new PoleOrbit(ctx.camera, ctx.dom, {
    color: spec.pole?.color ?? 0xffcc00,
    ballRadius: spec.ballRadius ?? ctx.defaults.ballRadius,
    radius: poleRadius,
    dragControl: ctx.dragControl,
  });
  pole.bind(midObj, rootObj, target); // 轨道中心 = 肘/膝；链轴 = 根骨→端球（端球被可达钳制收拢过，与实际链一致）
  pole.onPress = () => ctx.select(spec.name);
  ctx.scene.add(pole);

  const modifier = new TwoBoneIkModifier([{
    rootBone: spec.rootBone, middleBone: spec.middleBone, endBone: spec.endBone,
    target, poleTarget: pole.ball,
  }]);
  const guide = spec.pole?.guide === false ? null : new PoleGuide(ctx.scene, pole.ball, midObj);

  // 端骨旋转通道（endRotation）：旋转环驱动端骨朝向；CopyTransform 只拷旋转、不碰位置（位置仍归端球/链 IK）
  let rings: RotateRings | undefined;
  const modifiers: BuiltControl['modifiers'] = [{ modifier, rootBone: spec.rootBone }];
  if (spec.endRotation) {
    rings = new RotateRings(ctx.camera, ctx.dom, { ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius, dragControl: ctx.dragControl });
    rings.setJoint(endObj);
    rings.setOrientationCarry(endObj.parent ?? midObj); // FK 语义：端骨朝向相对中骨携带（弯肘/膝时腕/脚尖跟着相对转）
    rings.onPress = () => ctx.select(spec.name);
    ctx.scene.add(rings);
    // rootBone=端骨（链上最深）：深度排序保证定向在链 IK 摆位之后执行
    modifiers.push({
      modifier: new CopyTransformModifier([{ applyBone: spec.endBone, referenceType: 'object', referenceObject: rings, copyPosition: false, copyRotation: true }]),
      rootBone: spec.endBone,
    });
  }

  let reachScale = spec.reachScale ?? ctx.defaults.reachScale;
  let keepAlive = spec.keepAlive ?? ctx.defaults.poleKeepAlive;
  let reach = 0;

  const applyReach = () => {
    if (reach > 0) {
      target.setReachConstraint(rootObj, reach * Math.min(reachScale, keepAlive));
    }
  };

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, modifier, rings,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
    setKeepAlive: (k) => { keepAlive = k; applyReach(); },
    setPoleRadius: (r) => { pole.setOrbitRadius(r); },
    setGuideVisible: (v) => { guide?.setVisible(v); },
  };

  return {
    name: spec.name, kind: 'limb',
    targets: [target],
    // pole 是纯位置控制点（不参与 W/E 切换）：rotate 模式只有端球藏、端骨环上场，pole 常驻
    moveTargets: [target],
    rotateRings: rings ? [rings] : undefined,
    modifiers,
    postSolve() {
      const m = measureChain(rootObj, spec.rootBone, spec.endBone);
      if (!m) throw ThreeIKError.configError(`limb 控制点 "${spec.name}": ${spec.rootBone}→${spec.endBone} 不是直系链`);
      reach = m.reach;
      // 顺序即语义：先收拢钳制，再捕获携带偏移（否则偏移按未收拢位置算）
      applyReach();
      if (spec.carry !== false) target.setCarry(rootObj);
      // pole 初始方向：spec 位置或「肘/膝 + 角色朝向×半径」作提示，首帧投影 ⊥ 链轴落环
      pole.setDirectionHint(spec.pole?.position
        ? toVec3(spec.pole.position)
        : midObj.getWorldPosition(new Vector3()).addScaledVector(ctx.facing, poleRadius));
      pole.update();

      // A：roll 修正实测——取「当前正指向 pole 球的中骨局部轴」为 poleDirection。
      // 用实测向量而非写死基轴：Mixamo 左右臂局部系不一致，写死会带可见跳变
      if ((spec.poleDirection ?? 'auto') === 'auto') {
        rootObj.getWorldPosition(_rootPos);
        endObj.getWorldPosition(_endPos);
        pole.ball.getWorldPosition(_polePos);
        const chainAxis = _endPos.sub(_rootPos).normalize();
        const pv = _polePos.sub(_rootPos);             // pv = pole − root
        pv.addScaledVector(chainAxis, -pv.dot(chainAxis)); // 去轴向分量（getProjectedNormal）
        if (pv.lengthSq() >= 1e-8) {
          pv.normalize();
          midObj.getWorldQuaternion(_midQ).invert();
          pv.applyQuaternion(_midQ);                    // 世界 → 中骨局部
          modifier.updateConfig(0, { poleDirection: 'custom', poleDirectionVector: pv.clone() });
        }
      }
      rings?.update(); // 环心/朝向初始同步（首解后姿势）
    },
    update() {
      pole.update();
      rings?.update();
      guide?.update();
    },
    handle,
    dispose() {
      guide?.dispose();
      ctx.scene.remove(target);
      target.dispose();
      pole.dispose();
      rings?.dispose();
    },
  };
}
