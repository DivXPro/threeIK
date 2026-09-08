import { Matrix4, Quaternion, Vector3 } from 'three';
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
  /** 肘部旋转环半径（默认 defaults.ringRadius） */
  ringRadius?: number;
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
  /** pole 双通道影子球（W 模式操纵器：角度=肘/膝朝向、径向=弯度；E 模式收起、换肘环上场） */
  readonly pole: PoleOrbit;
  /** 肘/膝二维旋转环（E 模式操纵器：X 环 = 绕上臂轴 swivel，Y 环 = 绕弯折轴伸缩；
   *  纯肘关节 FK——转前臂、肘/肩钉住不动） */
  readonly elbowRings: RotateRings;
  /** 端骨旋转环（spec.endRotation: true 时存在） */
  readonly rings?: RotateRings;
  /** 实测链可达半径（米，世界空间，未经 keepAlive 收缩） */
  readonly reach: number;
  setReachScale(scale: number): void;
  setKeepAlive(k: number): void;
}

// A 段（poleDirection 实测）、逐帧轨道几何与肘环坐标架的临时量
const _rootPos = new Vector3();
const _endPos = new Vector3();
const _midPos = new Vector3();
const _polePos = new Vector3();
const _axis = new Vector3();
const _midQ = new Quaternion();
const _m = new Matrix4();
// 肘环拖拽快照（pointerdown 捕获，拖拽全程有效）：拖前肘位置与前臂向量
const _elbow0 = new Vector3();
const _fore0 = new Vector3();

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制，拖它 = IK，弯度由它离根的远近决定——Maya 同款语义）
 *  + 肘/膝操纵器（W/E 换班）——
 *   W 模式 = pole 双通道影子球（球贴在肘/膝的 ⊥ 链轴影子处：绕轴转 = 调朝向，外拽/内推 = 调弯度，
 *   手钉在原地或沿链轴滑动——「手定肘动」语义）；
 *   E 模式 = 肘部二维旋转环（X 环绕上臂轴 = 前臂 swivel，Y 环绕弯折轴 = 伸缩，纯肘关节 FK，
 *   手绕肘画弧——「肘定手动」语义，与端球 IK 复核天然一致）。
 *  内置 roll 修正实测（A）。 */
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
  // pole/肘环是常驻操纵器（不参与选中体系）：点它只认领按下（防空白失焦），
  // 不选中所属 limb——否则点肘部操纵器会把手的轴箭头点亮，误导用户以为选中了手
  pole.onPress = () => ctx.claim();
  ctx.scene.add(pole);

  // 肘部二维旋转环（E 模式操纵器，与 pole 球 W/E 换班）：X 环 = 绕上臂轴 swivel（前臂绕轴滚），
  // Y 环 = 绕弯折轴 bend（前臂在弯折面内收/展 = 伸缩）。增量模式：拖环不改写环自身朝向，
  // 逐事件把角度增量交给下面的 onRotateDelta（转前臂、移动端球）
  const elbowRings = new RotateRings(ctx.camera, ctx.dom, {
    ringRadius: spec.pole?.ringRadius ?? ctx.defaults.ringRadius,
    dragControl: ctx.dragControl,
    rings: [0, 1],
    viewRing: false,
  });
  elbowRings.setJoint(midObj);
  // 拖拽快照（pointerdown 时捕获）：累计角 × 拖前前臂 = 累计旋转——同一帧连发多个 move、
  // 求解器还没跑（骨骼位置未更新）时，逐事件读骨骼会丢旋转，快照×累计角恒正确
  elbowRings.onPress = () => {
    ctx.claim();
    midObj.getWorldPosition(_elbow0);
    endObj.getWorldPosition(_fore0).sub(_elbow0);
  };
  ctx.scene.add(elbowRings);

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

  // 肘环坐标架（非拖拽时每帧重算）：X = 上臂轴（肩→肘，swivel 环），Y = 弯折轴（上臂轴 × 肘离轴
  // 方向，bend 环），Z = X×Y。肘离轴方向相对「链轴（根→端球）」取——弯时取实测、直时取 pole 球
  // 携带的偏好方向（影子球恒有 2cm 偏移，方向恒非零）：伸直手臂上 bend 环依旧定义良好，
  // 掰的方向 = pole 指向。（注意：肘恒在上臂轴上，相对上臂轴的离轴分量恒为 0，别用错轴）
  elbowRings.orientationSource = (out) => {
    rootObj.getWorldPosition(_rootPos);
    midObj.getWorldPosition(_midPos);
    target.getWorldPosition(_endPos);
    _axis.copy(_midPos).sub(_rootPos); // X = 上臂轴
    if (_axis.lengthSq() < 1e-12) return;
    _axis.normalize();
    _polePos.copy(_endPos).sub(_rootPos); // 链轴（根→端球）
    if (_polePos.lengthSq() < 1e-12) return;
    _polePos.normalize();
    _endPos.copy(_midPos).sub(_rootPos); // 弯时：肘实测离链轴方向
    _endPos.addScaledVector(_polePos, -_endPos.dot(_polePos));
    if (_endPos.lengthSq() < 1e-8) {
      pole.ball.getWorldPosition(_endPos).sub(_rootPos); // 直时：pole 偏好方向
      _endPos.addScaledVector(_polePos, -_endPos.dot(_polePos));
      if (_endPos.lengthSq() < 1e-10) return;
    }
    _endPos.normalize();
    _midPos.crossVectors(_axis, _endPos).normalize(); // Y = 弯折轴
    _polePos.crossVectors(_axis, _midPos);            // Z = X×Y
    out.setFromRotationMatrix(_m.makeBasis(_axis, _midPos, _polePos));
  };

  // 肘环增量通道（axisIndex：0 = swivel 绕上臂轴，1 = bend 绕弯折轴；angle = 按下以来的累计角，
  // axisWorld = 过肘的冻结拖轴）：拖前前臂（onPress 快照）绕拖轴转 angle，端球搬到弧上的新位置——
  // 纯肘关节 FK，肘/上臂/肩全程不动，旋转保距（新链距恒 ≤ len1+len2）下一帧 TwoBone 复核自然可达。
  // pole 方向随后按真相重同步：弯时贴肘真实离轴方向（肘没动，求解器把它留在原地，防残差漂移）；
  // 直时肘离轴退化，swivel 把偏好方向随环绕链轴转（保持「往哪边掰」的选择）
  elbowRings.onRotateDrag = (axisIndex, angle, axisWorld) => {
    rootObj.getWorldPosition(_rootPos);
    pole.ball.getWorldPosition(_polePos).sub(_rootPos); // 拖前的 pole 偏好方向（拖拽中球不动，伸直时也非零）
    _endPos.copy(_fore0).applyAxisAngle(axisWorld, angle); // 拖前前臂 × 累计角 = 累计旋转
    target.moveTo(_endPos.add(_elbow0));                   // 手 = 肘 + 新前臂
    target.getWorldPosition(_endPos);
    _axis.copy(_endPos).sub(_rootPos);                     // 新链轴
    if (_axis.lengthSq() < 1e-12) return;
    _axis.normalize();
    _midPos.copy(_elbow0).sub(_rootPos);                   // 肘离轴向量（肘没动过）
    _midPos.addScaledVector(_axis, -_midPos.dot(_axis));
    if (_midPos.lengthSq() >= 1e-8) {
      pole.setDirection(_midPos);
    } else if (axisIndex === 0) {
      _polePos.addScaledVector(_axis, -_polePos.dot(_axis));
      if (_polePos.lengthSq() >= 1e-10) {
        pole.setDirection(_polePos.normalize().applyAxisAngle(_axis, angle));
      }
    }
  };

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, elbowRings, modifier, rings,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
    setKeepAlive: (k) => { keepAlive = k; applyReach(); },
  };

  return {
    name: spec.name, kind: 'limb',
    targets: [target],
    // 端球参与 move 模式切换；端骨环（endRotation）走选中+rotate 模式体系；
    // pole 球↔肘环是常驻操纵器，经 onModeChange 自行换班（W = 球、E = 环）
    moveTargets: [target],
    rotateRings: rings ? [rings] : undefined,
    modifiers,
    onModeChange(mode) {
      const move = mode === 'move';
      pole.visible = move;
      elbowRings.setVisible(!move);
      elbowRings.setInteractive(!move);
    },
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
      elbowRings.update();
    },
    update() {
      syncOrbitFrame();
      pole.update();
      elbowRings.update();
      rings?.update();
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
      pole.dispose();
      elbowRings.dispose();
      rings?.dispose();
    },
  };
}
