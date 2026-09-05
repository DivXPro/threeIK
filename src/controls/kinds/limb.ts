import { MathUtils, Quaternion, Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { TwoBoneIkModifier } from '../../modifiers/ik/two-bone-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { DragTarget } from '../drag-target';
import { RotateRings } from '../rotate-rings';
import { PoleGuide } from '../guides';
import { measureChain } from '../measure-chain';
import { resolveConeAxis, toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase, type ManipulatorMode } from '../types';

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
  /** pole 拖球 */
  readonly pole: DragTarget;
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
const _sEnd = new Vector3();
const _sAxis = new Vector3();
const _sOff = new Vector3();
const _sMove = new Vector3();

/** off 相对 axis 的垂直分量长度（axis 须为单位向量） */
function perpLen(off: Vector3, axis: Vector3): number {
  return Math.sqrt(Math.max(0, off.lengthSq() - off.dot(axis) ** 2));
}

/** 双骨链平面几何：已知上下骨长 a/b 与中骨离轴高度 h，求端骨距根骨的链轴距离。
 *  轴被中骨垂足分成 sqrt(a²−h²) 与 sqrt(b²−h²) 两段（h ≤ min(a,b)） */
function chainSpan(lenA: number, lenB: number, h: number): number {
  const hh = h * h;
  return Math.sqrt(Math.max(0, lenA * lenA - hh)) + Math.sqrt(Math.max(0, lenB * lenB - hh));
}
// A 段（poleDirection 实测）临时量
const _rootPos = new Vector3();
const _endPos = new Vector3();
const _midPos = new Vector3();
const _polePos = new Vector3();
const _midQ = new Quaternion();

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制）+ pole 球（恒距方向锥，双通道转向球）+ 引导线，
 *  内置 roll 修正实测（A）与 pole 双通道（move 拖 = 调弯曲量 / rotate 拖 = swivel）两个交互层结论 */
export function buildLimbControl(ctx: ControlBuildContext, spec: LimbControlSpec): BuiltControl {
  const rootObj = ctx.bone(spec.rootBone);
  const midObj = ctx.bone(spec.middleBone);
  const endObj = ctx.bone(spec.endBone);

  const initial = spec.position ? toVec3(spec.position) : endObj.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff5533, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.setAxisHandles(true); // 移动操纵器 Maya 化：轴箭头+中心球（pole 是双通道转向球，不开箭头）
  ctx.scene.add(target);

  const axis = resolveConeAxis(spec.pole?.coneAxis, ctx.facing);
  let poleRadius = spec.pole?.radius ?? ctx.defaults.poleRadius;
  let angleDeg = spec.pole?.coneAngleDeg ?? ctx.defaults.poleAngleDeg;
  const poleInitial = spec.pole?.position
    ? toVec3(spec.pole.position)
    : midObj.getWorldPosition(new Vector3()).addScaledVector(axis, poleRadius);
  const pole = new DragTarget(ctx.camera, ctx.dom, poleInitial, spec.pole?.color ?? 0xffcc00, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  ctx.scene.add(pole);

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
  let lenA = 0; // 上骨长（root→middle）
  let lenB = 0; // 下骨长（middle→end）
  // pole 双通道：move 模式拖肘球 = 调弯曲量（bend），rotate 模式拖 = 绕轴 swivel（纯 pole 本职）。
  // 模式由 SkeletonControls.setManipulatorMode 经 BuiltControl.setMode 下发
  let currentMode: ManipulatorMode = 'move';
  let poleBendActive = false; // 一次 move 模式 pole 拖拽内 bend 激活，松手即交还恒距球面
  let poleH0 = 0; // 进入 bend 时 pole 球的离轴距离（映射零点，防跳变）
  let poleHElbow0 = 0; // 进入 bend 时肘部（中骨）的离轴高度，由当前骨距反推

  const applyReach = () => {
    if (reach > 0) {
      target.setReachConstraint(rootObj, reach * Math.min(reachScale, keepAlive));
    }
  };
  const applyPoleCone = () => pole.setConeConstraint(midObj, axis, MathUtils.degToRad(angleDeg), poleRadius, poleRadius);

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, modifier, rings,
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
    moveTargets: [target], // pole 是双通道转向球（move=弯曲量，rotate=swivel），两种模式下都可用，不参与切换
    rotateRings: rings ? [rings] : undefined,
    modifiers,
    setMode(mode) {
      currentMode = mode;
      // 模式切换发生在 pole 拖拽中途：结束 bend，球立即吸回恒距球面交还 pole 本职
      if (poleBendActive) { pole.setConstraintsSuspended(false); poleBendActive = false; }
    },
    postSolve() {
      const m = measureChain(rootObj, spec.rootBone, spec.endBone);
      if (!m) throw ThreeIKError.configError(`limb 控制点 "${spec.name}": ${spec.rootBone}→${spec.endBone} 不是直系链`);
      reach = m.reach;
      // 上下骨长（pole 弯曲映射用；骨长不变，postSolve 量一次即可）
      lenA = rootObj.getWorldPosition(_rootPos).distanceTo(midObj.getWorldPosition(_midPos));
      lenB = _midPos.distanceTo(endObj.getWorldPosition(_endPos));
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
    },
    update() {
      // pole 双通道之 move 模式：拖肘球 = 位置操作 → 把肘部拉离「根骨→端球」连线 = 调弯曲量
      // （伸直时拖 = 从直变弯；任何弯度下拖都继续调，无伸展门槛）。映射：球离轴距离的变化量
      // 1:1 转为肘部离轴高度的变化：h肘 = h肘0 + (h球 − h球0)，再由平面几何
      // d = √(a²−h肘²)+√(b²−h肘²) 求端球应到的轴上位置：拖远→弯，拖回→伸（过界被钳回，可逆）。
      // 拖拽首帧实测 (h球0, h肘0) 零点：进入瞬间零跳变；h肘0 用余弦定理从当前骨距反推——
      // 不能用球的绝对距离当弯曲量：pole 球自带恒距半径，拉直时它离轴已≈半径。
      // rotate 模式拖肘球 = 纯 swivel：锥约束保持生效，pole 方向权照常驱动中骨绕轴转，本块不介入
      if (currentMode === 'move') {
        if (!pole.isDragging) {
          if (poleBendActive) { pole.setConstraintsSuspended(false); poleBendActive = false; }
        } else {
          rootObj.getWorldPosition(_sRoot);
          _sAxis.subVectors(target.position, _sRoot).normalize();
          if (!poleBendActive) {
            const d0 = _sRoot.distanceTo(target.position);
            if (d0 > 1e-4) { // 端球贴着根骨时轴退化，本次拖拽不启用 bend
              poleBendActive = true;
              pole.setConstraintsSuspended(true); // 球离面自由飞
              _sOff.subVectors(pole.position, _sRoot);
              poleH0 = perpLen(_sOff, _sAxis);
              const aProj = (d0 * d0 + lenA * lenA - lenB * lenB) / (2 * d0); // 余弦定理：上骨在轴上的投影
              poleHElbow0 = Math.sqrt(Math.max(0, lenA * lenA - aProj * aProj));
            }
          }
          if (poleBendActive) {
            _sOff.subVectors(pole.position, _sRoot);
            const hElbow = MathUtils.clamp(
              poleHElbow0 + perpLen(_sOff, _sAxis) - poleH0,
              0, Math.min(lenA, lenB) * 0.999,
            );
            const d = Math.max(0.05, chainSpan(lenA, lenB, hElbow));
            // moveTo 过可达钳制：拖回线上时手球最多回到 reach×keepAlive 边界（= 允许的最直）
            target.moveTo(_sMove.copy(_sRoot).addScaledVector(_sAxis, d));
          }
        }
      }
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
      rings?.dispose();
    },
  };
}
