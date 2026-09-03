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
  /** 伸展兜底舵控：pole 拖拽中且链伸展率 >0.985 时，pole 帧间位移 1:1 转交端球
   *  （HIK FK fallthrough 的拖球等价物；默认 keepAlive 0.96 下不会触发，默认 false） */
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

const STEER_EXT_THRESHOLD = 0.985;
const _sRoot = new Vector3();
const _sEnd = new Vector3();
const _sDelta = new Vector3();
// A 段（poleDirection 实测）临时量
const _rootPos = new Vector3();
const _endPos = new Vector3();
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
  let hasPrev = false;
  const prevPos = new Vector3();

  const applyReach = () => {
    if (reach > 0) target.setReachConstraint(rootObj, reach * Math.min(reachScale, keepAlive));
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
    setSteer: (on) => { steerOn = on; hasPrev = false; },
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
      // B：伸展兜底舵控——pole 位置权在拉直时几何归零，此时把 pole 位移转交端球，
      // 整条直臂/腿被 pole 舵控跟随；拖向身体伸展率回落，pole 自动恢复本职
      if (steerOn) {
        if (!pole.isDragging) {
          hasPrev = false;
        } else {
          rootObj.getWorldPosition(_sRoot);
          endObj.getWorldPosition(_sEnd);
          const ext = _sRoot.distanceTo(_sEnd) / reach; // 对原始链长取伸展率（keepAlive 只收球）
          if (ext > STEER_EXT_THRESHOLD && hasPrev) {
            _sDelta.subVectors(pole.position, prevPos);
            if (_sDelta.lengthSq() > 1e-10) {
              // moveTo 过约束管线（可达球收拢照旧）；端球的携带偏移随动刷新
              target.moveTo(_sDelta.add(target.position));
            }
          }
          prevPos.copy(pole.position);
          hasPrev = true;
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
