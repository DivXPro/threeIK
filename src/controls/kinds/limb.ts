import { MathUtils, Quaternion, Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { TwoBoneIkModifier } from '../../modifiers/ik/two-bone-ik';
import { DragTarget } from '../drag-target';
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
  /** 伸展兜底舵控（默认 false）：pole 拖拽中且链已顶到端球可达边界（拉到当前允许的最直）时进入舵控——
   *  pole 球离面自由飞，其到「根骨→端球」连线垂直距离的变化量 1:1 转为肘部离轴高度的变化：
   *  拖离线远 → 弯（往哪边拖往哪边弯）；拖回线上 → 伸直（可逆）；绕线转 → 距离不变，纯 swivel。
   *  一次拖拽内锁存，松手球吸回恒距球面、交还 pole 本职 */
  steer?: boolean;
}

export interface LimbControlHandle extends ControlHandleBase {
  readonly kind: 'limb';
  readonly modifier: TwoBoneIkModifier;
  /** pole 拖球 */
  readonly pole: DragTarget;
  /** 实测链可达半径（米，世界空间，未经 keepAlive 收缩） */
  readonly reach: number;
  setReachScale(scale: number): void;
  setKeepAlive(k: number): void;
  setPoleRadius(radius: number): void;
  setPoleConeAngleDeg(deg: number): void;
  setSteer(on: boolean): void;
  setGuideVisible(visible: boolean): void;
}

/** 舵控触发线：根→端骨距离 ≥ 端球当前可达上限 × 0.98（即"拉到允许的最直"） */
const STEER_EXT_THRESHOLD = 0.98;
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

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制）+ pole 球（恒距方向锥）+ 引导线，
 *  内置 roll 修正实测（A）与伸展舵控（B）两个交互层结论 */
export function buildLimbControl(ctx: ControlBuildContext, spec: LimbControlSpec): BuiltControl {
  const rootObj = ctx.bone(spec.rootBone);
  const midObj = ctx.bone(spec.middleBone);
  const endObj = ctx.bone(spec.endBone);

  const initial = spec.position ? toVec3(spec.position) : endObj.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff5533, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
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

  let reachScale = spec.reachScale ?? ctx.defaults.reachScale;
  let keepAlive = spec.keepAlive ?? ctx.defaults.poleKeepAlive;
  let steerOn = spec.steer ?? false;
  let reach = 0;
  let effReach = 0; // 端球当前可达上限（reach × min(reachScale, keepAlive)），舵控触发线的基准
  let lenA = 0; // 上骨长（root→middle）
  let lenB = 0; // 下骨长（middle→end）
  let steerLatched = false; // 一次拖拽内舵控一旦触发即锁存，松手才交还 pole 本职
  let steerH0 = 0; // 进入舵控时 pole 球的离轴距离（映射零点，防跳变）
  let steerHElbow0 = 0; // 进入舵控时肘部（中骨）的离轴高度，由当前骨距反推

  const applyReach = () => {
    if (reach > 0) {
      effReach = reach * Math.min(reachScale, keepAlive);
      target.setReachConstraint(rootObj, effReach);
    }
  };
  const applyPoleCone = () => pole.setConeConstraint(midObj, axis, MathUtils.degToRad(angleDeg), poleRadius, poleRadius);

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, modifier,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
    setKeepAlive: (k) => { keepAlive = k; applyReach(); },
    setPoleRadius: (r) => { poleRadius = r; applyPoleCone(); },
    setPoleConeAngleDeg: (d) => { angleDeg = d; applyPoleCone(); },
    setSteer: (on) => {
      steerOn = on;
      if (steerLatched) { pole.setConstraintsSuspended(false); steerLatched = false; }
    },
    setGuideVisible: (v) => { guide?.setVisible(v); },
  };

  return {
    name: spec.name, kind: 'limb',
    targets: [target, pole],
    modifiers: [{ modifier, rootBone: spec.rootBone }],
    postSolve() {
      const m = measureChain(rootObj, spec.rootBone, spec.endBone);
      if (!m) throw ThreeIKError.configError(`limb 控制点 "${spec.name}": ${spec.rootBone}→${spec.endBone} 不是直系链`);
      reach = m.reach;
      // 上下骨长（舵控的离轴距离↔弯度映射用；骨长不变，postSolve 量一次即可）
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
    },
    update() {
      // B：伸展兜底舵控——链顶到端球可达边界时 pole 方向权几何归零，此时把球从恒距球面上放开，
      // 用球离轴距离的变化量 1:1 驱动肘部离轴高度：h肘 = h肘0 + (h球 − h球0)，再由平面几何
      // d = √(a²−h肘²)+√(b²−h肘²) 求端球应到的轴上位置：拖远→弯，拖回→伸（过界被钳回，可逆），
      // 绕轴转→h球不变→纯 swivel。锁存时实测 (h球0, h肘0) 零点：进入瞬间零跳变；h肘0 用余弦定理
      // 从当前骨距反推——不能用球的绝对距离当弯曲量：pole 球自带恒距半径，拉直时它离轴已≈半径
      if (steerOn) {
        if (!pole.isDragging) {
          if (steerLatched) { pole.setConstraintsSuspended(false); steerLatched = false; }
        } else {
          rootObj.getWorldPosition(_sRoot);
          _sAxis.subVectors(target.position, _sRoot).normalize();
          if (!steerLatched && effReach > 0) {
            endObj.getWorldPosition(_sEnd);
            steerLatched = _sRoot.distanceTo(_sEnd) / effReach > STEER_EXT_THRESHOLD;
            if (steerLatched) {
              pole.setConstraintsSuspended(true); // 球离面自由飞
              _sOff.subVectors(pole.position, _sRoot);
              steerH0 = perpLen(_sOff, _sAxis);
              const d0 = _sRoot.distanceTo(_sEnd);
              const aProj = (d0 * d0 + lenA * lenA - lenB * lenB) / (2 * d0); // 余弦定理：上骨在轴上的投影
              steerHElbow0 = Math.sqrt(Math.max(0, lenA * lenA - aProj * aProj));
            }
          }
          if (steerLatched) {
            _sOff.subVectors(pole.position, _sRoot);
            const hElbow = MathUtils.clamp(
              steerHElbow0 + perpLen(_sOff, _sAxis) - steerH0,
              0, Math.min(lenA, lenB) * 0.999,
            );
            const d = Math.max(0.05, chainSpan(lenA, lenB, hElbow));
            // moveTo 过可达钳制：拖回线上时手球最多回到 effReach 边界（= 允许的最直）
            target.moveTo(_sMove.copy(_sRoot).addScaledVector(_sAxis, d));
          }
        }
      }
      guide?.update();
    },
    handle,
    dispose() {
      guide?.dispose();
      ctx.scene.remove(target);
      ctx.scene.remove(pole);
      target.dispose();
      pole.dispose();
    },
  };
}
