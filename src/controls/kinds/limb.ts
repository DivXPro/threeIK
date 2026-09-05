import { MathUtils, Quaternion, Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { TwoBoneIkModifier } from '../../modifiers/ik/two-bone-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { DragTarget } from '../drag-target';
import { RotateRings } from '../rotate-rings';
import { PoleGuide } from '../guides';
import { measureChain } from '../measure-chain';
import { resolveConeAxis, toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface LimbPoleSpec {
  color?: number;
  /** 初始位置（世界坐标）；缺省 = 中骨关节 + 锥轴×半径 */
  position?: Vector3 | [number, number, number];
  /** 方向锥轴：膝用 'facing'（默认）；肘的自然朝向偏后，用 'backward' */
  coneAxis?: 'facing' | 'backward' | Vector3;
  /** 锥半角（°，默认 defaults.poleAngleDeg）；肘要覆盖后下方自然姿势，通常比膝大（如 130） */
  coneAngleDeg?: number;
  /** 恒距半径（锥 min=max，默认 defaults.poleRadius） */
  radius?: number;
  /** 随中骨关节携带，默认 true */
  carry?: boolean;
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
  readonly modifier: TwoBoneIkModifier;
  /** pole 拖球（move 模式：箭头+中心球调肘朝向） */
  readonly pole: DragTarget;
  /** pole swivel 环（rotate 模式：拖环 = 肘绕「根→端」轴转） */
  readonly poleRings: RotateRings;
  /** 端骨旋转环（spec.endRotation: true 时存在） */
  readonly rings?: RotateRings;
  /** 实测链可达半径（米，世界空间，未经 keepAlive 收缩） */
  readonly reach: number;
  setReachScale(scale: number): void;
  setKeepAlive(k: number): void;
  setPoleRadius(radius: number): void;
  setPoleConeAngleDeg(deg: number): void;
  setGuideVisible(visible: boolean): void;
}

const _sRoot = new Vector3();
const _sAxis = new Vector3();
const _sOff = new Vector3();
const _sMove = new Vector3();
// A 段（poleDirection 实测）临时量
const _rootPos = new Vector3();
const _endPos = new Vector3();
const _midPos = new Vector3();
const _polePos = new Vector3();
const _midQ = new Quaternion();

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制，弯度由它离根的远近决定——Maya 同款语义）
 *  + pole 转向控制（恒距方向锥，只管肘/膝朝向不管弯度）+ 引导线。
 *  pole 操纵器随模式切换（Maya W/E）：move = 箭头+中心球拖位置调朝向；rotate = 肘部旋转环，
 *  任意环的角增量映射为绕「根→端」链轴的 swivel。内置 roll 修正实测（A）。 */
export function buildLimbControl(ctx: ControlBuildContext, spec: LimbControlSpec): BuiltControl {
  const rootObj = ctx.bone(spec.rootBone);
  const midObj = ctx.bone(spec.middleBone);
  const endObj = ctx.bone(spec.endBone);

  const initial = spec.position ? toVec3(spec.position) : endObj.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff5533, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.setAxisHandles(true); // 移动操纵器 Maya 化：轴箭头+中心球
  ctx.scene.add(target);

  const axis = resolveConeAxis(spec.pole?.coneAxis, ctx.facing);
  let poleRadius = spec.pole?.radius ?? ctx.defaults.poleRadius;
  let angleDeg = spec.pole?.coneAngleDeg ?? ctx.defaults.poleAngleDeg;
  const poleInitial = spec.pole?.position
    ? toVec3(spec.pole.position)
    : midObj.getWorldPosition(new Vector3()).addScaledVector(axis, poleRadius);
  const pole = new DragTarget(ctx.camera, ctx.dom, poleInitial, spec.pole?.color ?? 0xffcc00, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  pole.setAxisHandles(true); // pole 也是普通移动操纵器（Maya 里 pole vector 就是个走 W 移动工具的普通节点）
  ctx.scene.add(pole);

  // pole swivel 环（rotate 模式上场）：环心跟随 pole 球；拖任意环 = 把 pole 绕「根骨→端球」
  // 链轴旋转（swivel）。pole 的唯一自由度就是绕链轴转，所以环的角增量按链轴符号对齐后全量映射
  const onPoleRingDrag = (axisW: Vector3, dAngle: number) => {
    rootObj.getWorldPosition(_sRoot);
    _sAxis.subVectors(target.position, _sRoot);
    if (_sAxis.lengthSq() < 1e-8) return;
    _sAxis.normalize();
    const s = Math.sign(axisW.dot(_sAxis)) || 1;
    pole.getWorldPosition(_sOff).sub(_sRoot);
    _sOff.applyAxisAngle(_sAxis, dAngle * s);
    pole.moveTo(_sMove.copy(_sRoot).add(_sOff)); // 过锥钳制：方向进求解，半径收回球面
  };
  const poleRings = new RotateRings(ctx.camera, ctx.dom, {
    ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius,
    dragControl: ctx.dragControl,
    onDragDelta: onPoleRingDrag,
  });
  poleRings.setJoint(pole); // 环心随球；球不可旋转，环朝向闲时回世界轴对齐
  ctx.scene.add(poleRings);

  const modifier = new TwoBoneIkModifier([{
    rootBone: spec.rootBone, middleBone: spec.middleBone, endBone: spec.endBone,
    target, poleTarget: pole,
  }]);
  const guide = spec.pole?.guide === false ? null : new PoleGuide(ctx.scene, pole, midObj);

  // 端骨旋转通道（endRotation）：旋转环驱动端骨朝向；CopyTransform 只拷旋转、不碰位置（位置仍归端球/链 IK）
  let rings: RotateRings | undefined;
  const modifiers: BuiltControl['modifiers'] = [{ modifier, rootBone: spec.rootBone }];
  if (spec.endRotation) {
    rings = new RotateRings(ctx.camera, ctx.dom, { ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius, dragControl: ctx.dragControl });
    rings.setJoint(endObj);
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
  const applyPoleCone = () => pole.setConeConstraint(midObj, axis, MathUtils.degToRad(angleDeg), poleRadius, poleRadius);

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, poleRings, modifier, rings,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
    setKeepAlive: (k) => { keepAlive = k; applyReach(); },
    setPoleRadius: (r) => { poleRadius = r; applyPoleCone(); },
    setPoleConeAngleDeg: (d) => { angleDeg = d; applyPoleCone(); },
    setGuideVisible: (v) => { guide?.setVisible(v); },
  };

  return {
    name: spec.name, kind: 'limb',
    targets: [target, pole],
    moveTargets: [target, pole], // pole 是普通移动操纵器：move 显球+箭头，rotate 藏球换 swivel 环
    rotateRings: rings ? [poleRings, rings] : [poleRings],
    modifiers,
    postSolve() {
      const m = measureChain(rootObj, spec.rootBone, spec.endBone);
      if (!m) throw ThreeIKError.configError(`limb 控制点 "${spec.name}": ${spec.rootBone}→${spec.endBone} 不是直系链`);
      reach = m.reach;
      // 顺序即语义：先收拢钳制，再捕获携带偏移（否则偏移按未收拢位置算）
      applyReach();
      applyPoleCone();
      if (spec.carry !== false) target.setCarry(rootObj);
      if (spec.pole?.carry !== false) pole.setCarry(midObj);

      // A：roll 修正实测——取「当前正指向 pole 球的中骨局部轴」为 poleDirection。
      // 用实测向量而非写死基轴：Mixamo 左右臂局部系不一致，写死会带可见跳变
      if ((spec.poleDirection ?? 'auto') === 'auto') {
        rootObj.getWorldPosition(_rootPos);
        endObj.getWorldPosition(_endPos);
        pole.getWorldPosition(_polePos);
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
      poleRings.update();
    },
    update() {
      poleRings.update();
      rings?.update();
      guide?.update();
    },
    handle,
    dispose() {
      guide?.dispose();
      ctx.scene.remove(target);
      ctx.scene.remove(pole);
      target.dispose();
      pole.dispose();
      poleRings.dispose();
      rings?.dispose();
    },
  };
}
