import { Quaternion, Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { TwoBoneIkModifier } from '../../modifiers/ik/two-bone-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { DragTarget } from '../drag-target';
import { PoleOrbit } from '../pole-orbit';
import { RotateRings } from '../rotate-rings';
import { measureChain } from '../measure-chain';
import { toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface LimbPoleSpec {
  color?: number;
  /** 初始方向提示（世界坐标，投影到轨道面后作为球的初始方向）；缺省 = 中骨关节 + 角色朝向×0.2 */
  position?: Vector3 | [number, number, number];
}

export interface LimbControlSpec extends ControlSpecBase {
  kind: 'limb';
  rootBone: string;
  middleBone: string;
  endBone: string;
  /** 端球可达半径倍率（默认 defaults.reachScale） */
  reachScale?: number;
  /** pole 保活伸展上限（默认 defaults.poleKeepAlive = 1，不收缩）：pole 球恒 ⊥ 链轴，
   *  完全伸直时肘/膝方向由 roll 修正携带穿过退化点；<1 则钳球留弯度（如 0.96） */
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
  /** pole 双通道影子球（角度=肘/膝朝向、径向=弯度；纯位置控制点，两种模式都常驻可用） */
  readonly pole: PoleOrbit;
  /** 端骨旋转环（spec.endRotation: true 时存在） */
  readonly rings?: RotateRings;
  /** 实测链可达半径（米，世界空间，未经 keepAlive 收缩） */
  readonly reach: number;
  setReachScale(scale: number): void;
  setKeepAlive(k: number): void;
}

// A 段（poleDirection 实测）与逐帧轨道几何的临时量
const _rootPos = new Vector3();
const _endPos = new Vector3();
const _midPos = new Vector3();
const _polePos = new Vector3();
const _axis = new Vector3();
const _midQ = new Quaternion();

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制，拖它 = IK，弯度由它离根的远近决定——Maya 同款语义）
 *  + pole 双通道影子球（球贴在肘/膝的 ⊥ 链轴影子处：绕轴转 = 调朝向，外拽/内推 = 调弯度——
 *  径向拖动会沿链轴移动端球，手跟着动；拖端球时球自动滑回实测半径，兼作弯度仪表）。
 *  pole 是纯位置控制点，不参与 W/E 切换，两种模式都常驻。内置 roll 修正实测（A）。 */
export function buildLimbControl(ctx: ControlBuildContext, spec: LimbControlSpec): BuiltControl {
  const rootObj = ctx.bone(spec.rootBone);
  const midObj = ctx.bone(spec.middleBone);
  const endObj = ctx.bone(spec.endBone);

  const initial = spec.position ? toVec3(spec.position) : endObj.getWorldPosition(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xff5533, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.setAxisHandles(true); // 移动操纵器 Maya 化：轴箭头+中心球（选中后显示）
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);

  const pole = new PoleOrbit(ctx.camera, ctx.dom, {
    color: spec.pole?.color ?? 0xffcc00,
    ballRadius: spec.ballRadius ?? ctx.defaults.ballRadius,
    dragControl: ctx.dragControl,
  });
  pole.bind(rootObj, target); // 链轴 = 根骨→端球（端球被可达钳制收拢过，与实际链一致）
  // pole 是常驻纯位置操纵器（不参与选中体系）：点它只认领按下（防空白失焦），
  // 不选中所属 limb——否则点肘球会把手的轴箭头点亮，误导用户以为选中了手
  pole.onPress = () => ctx.claim();
  ctx.scene.add(pole);

  const modifier = new TwoBoneIkModifier([{
    rootBone: spec.rootBone, middleBone: spec.middleBone, endBone: spec.endBone,
    target, poleTarget: pole.ball,
  }]);

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
  let len1 = 0; // 根骨→中骨（上臂/大腿）
  let len2 = 0; // 中骨→端骨（前臂/小腿）

  const applyReach = () => {
    if (reach > 0) {
      target.setReachConstraint(rootObj, reach * Math.min(reachScale, keepAlive));
    }
  };

  /** 逐帧推送 pole 轨道几何：按链三角（len1/len2/D）实测中骨关节的轴上垂足 d 与离轴半径 r */
  const syncOrbitFrame = () => {
    rootObj.getWorldPosition(_rootPos);
    target.getWorldPosition(_endPos);
    _axis.copy(_endPos).sub(_rootPos);
    const D = _axis.length();
    if (D < 1e-6) return;
    const d = Math.min(Math.max((len1 * len1 - len2 * len2 + D * D) / (2 * D), -len1), len1);
    pole.setOrbitFrame(d, Math.sqrt(Math.max(len1 * len1 - d * d, 0)));
  };

  // 径向通道（弯度）：球离轴半径 ρ → 目标链距 D(ρ) = √(len1²−ρ²) + √(len2²−ρ²)（链三角反解），
  // 端球沿当前链轴滑到 D——手臂原地弯/伸，不甩向。ρ 上限留 5% 余量防 D 退化到 0（手压肩上，链轴未定义）
  pole.onRadiusDrag = (radius) => {
    const rho = Math.min(radius, Math.min(len1, len2) * 0.95);
    rootObj.getWorldPosition(_rootPos);
    target.getWorldPosition(_endPos);
    _axis.copy(_endPos).sub(_rootPos);
    if (_axis.lengthSq() < 1e-12) return;
    _axis.normalize();
    const D = Math.sqrt(Math.max(len1 * len1 - rho * rho, 0)) + Math.sqrt(Math.max(len2 * len2 - rho * rho, 0));
    target.moveTo(_endPos.copy(_rootPos).addScaledVector(_axis, D));
  };

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, modifier, rings,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
    setKeepAlive: (k) => { keepAlive = k; applyReach(); },
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
      // 段长（世界空间，姿势不变量）：pole 轨道几何与径向→弯度反解的输入
      rootObj.getWorldPosition(_rootPos);
      midObj.getWorldPosition(_midPos);
      endObj.getWorldPosition(_endPos);
      len1 = _rootPos.distanceTo(_midPos);
      len2 = _midPos.distanceTo(_endPos);
      // 顺序即语义：先收拢钳制，再捕获携带偏移（否则偏移按未收拢位置算）
      applyReach();
      if (spec.carry !== false) target.setCarry(rootObj);
      // pole 初始方向：spec 位置或「肘/膝 + 角色朝向×0.2」作提示，首帧投影 ⊥ 链轴落环
      syncOrbitFrame();
      pole.setDirectionHint(spec.pole?.position
        ? toVec3(spec.pole.position)
        : midObj.getWorldPosition(new Vector3()).addScaledVector(ctx.facing, 0.2));
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
      syncOrbitFrame();
      pole.update();
      rings?.update();
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
      pole.dispose();
      rings?.dispose();
    },
  };
}
