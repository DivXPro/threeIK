import { Matrix4, Quaternion, Vector3 } from 'three';
import { ThreeIKError } from '../../core/errors';
import { TwoBoneIkModifier } from '../../modifiers/ik/two-bone-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { RollModifier } from '../../modifiers/constraints/roll';
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
  /** pole 双通道影子球（W 模式操纵器：角度=肘/膝朝向、径向=弯度；E 模式退化为可点标记——
   *  点它选中肘部让肘环上场；两种模式都常显，它还是 TwoBone 的 poleTarget） */
  readonly pole: PoleOrbit;
  /** 肘/膝二维旋转环（E 模式 + 子选中 `${name}:elbow` 时上场——点 pole 球或肘环选中肘部：
   *  X 环 = 前臂/小腿绕自身纵轴扭转（位置全不动，只有朝向滚——上臂/大腿的旋转归肩部控制点，
   *  不在肘/膝上做）；Y 环 = 绕弯折轴伸缩，纯肘/膝关节 FK，手/脚绕关节画弧、关节钉住不动） */
  readonly elbowRings: RotateRings;
  /** 扭转通道的滚转 modifier（TwoBone 求解后对中骨施加附加滚转） */
  readonly rollModifier: RollModifier;
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
const _v1 = new Vector3();
const _v2 = new Vector3();
// 肘环拖拽快照（pointerdown 捕获，拖拽全程有效）：拖前肘位置与前臂向量
const _elbow0 = new Vector3();
const _fore0 = new Vector3();

/** 四肢双骨链（TwoBoneIK）控制点：端球（可达钳制，拖它 = IK，弯度由它离根的远近决定——Maya 同款语义）
 *  + 肘/膝操纵器（W/E 换班，独立选中目标 `${name}:elbow`——点 pole 球或肘环选中肘部）——
 *   W 模式 = pole 双通道影子球（球贴在肘/膝的 ⊥ 链轴影子处：绕轴转 = 调朝向，外拽/内推 = 调弯度，
 *   手钉在原地或沿链轴滑动——「手定肘动」语义，上臂/大腿的旋转也经此（pole vector）实现）；
 *   E 模式 = 肘/膝二维旋转环（选中肘部时上场）：红环 = 前臂/小腿绕自身纵轴扭转（位置全不动），
 *   绿环 = 绕弯折轴伸缩（手/脚绕关节画弧、关节钉住不动——纯关节 FK）；
 *   pole 球在 E 模式退化为可点标记留场——它是选中肘部的唯一入口（也是求解器的 poleTarget）。
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
  // pole 球/肘环 = 肘/膝自己的操纵器：点按 = 选中肘部子目标（`${name}:elbow`）——
  // W 模式选不选中它都在场（纯位置轨道球），E 模式选中后肘环上场、手臂本体的环不受影响
  pole.onPress = () => ctx.select(`${spec.name}:elbow`);
  ctx.scene.add(pole);

  // 肘/膝二维旋转环（E 模式 + 选中时上场，与端骨环同走 rotateRings 选中体系）：
  // X 环 = 前臂/小腿绕自身纵轴扭转（RollModifier 施加，位置全不动），Y 环 = 绕弯折轴伸缩
  // （增量模式：拖环不改写环自身朝向，累计角交给下面的 onRotateDrag）
  const elbowRings = new RotateRings(ctx.camera, ctx.dom, {
    ringRadius: spec.pole?.ringRadius ?? ctx.defaults.ringRadius,
    dragControl: ctx.dragControl,
    rings: [0, 1],
    viewRing: false,
  });
  elbowRings.setJoint(midObj);
  // 扭转通道的滚转落点（RollModifier 实例在下方 modifiers 数组声明后注册）：
  // TwoBone 把中骨朝向整体重写，附加滚转必须求解后重新施加
  let rollAngle = 0; // 持久扭转角（控制层持有，每帧由 rollModifier 重放）
  let rollBase = 0;  // 本次拖拽起始角（onPress 捕获，拖环 = rollBase + 累计角）
  // 拖拽快照（pointerdown 时捕获）：累计角 × 拖前前臂 = 累计旋转——同一帧连发多个 move、
  // 求解器还没跑（骨骼位置未更新）时，逐事件读骨骼会丢旋转，快照×累计角恒正确
  elbowRings.onPress = () => {
    ctx.select(`${spec.name}:elbow`); // 与 pole 球同一个选中目标：点肘环 = 选中肘部
    rollBase = rollAngle;
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
  // 扭转滚转：排序锚骨 = 中骨——TwoBone(根) 之后、端骨定向(端) 之前执行
  const rollModifier = new RollModifier([{ applyBone: spec.middleBone, childBone: spec.endBone }]);
  modifiers.push({ modifier: rollModifier, rootBone: spec.middleBone });
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

  // 肘环坐标架（非拖拽时每帧重算）：X = 前臂/小腿轴（肘→腕，twist 环——绕它滚 = 扭转，位置不动），
  // Y = 弯折轴（上臂轴 × 肘离链轴方向，bend 环——绕它转 = 伸缩），Z = X×Y。肘离链轴方向弯时取
  // 实测、直时取 pole 球携带的偏好方向（影子球恒有 2cm 偏移，方向恒非零）：伸直手臂上 bend 环
  // 依旧定义良好，掰的方向 = pole 指向（注意：肘恒在上臂轴上，相对上臂轴的离轴分量恒为 0，别用错轴）
  elbowRings.orientationSource = (out) => {
    rootObj.getWorldPosition(_rootPos);
    midObj.getWorldPosition(_midPos);
    endObj.getWorldPosition(_endPos);
    target.getWorldPosition(_polePos);
    _axis.copy(_midPos).sub(_rootPos); // 上臂轴（弯折轴计算用）
    if (_axis.lengthSq() < 1e-12) return;
    _axis.normalize();
    _polePos.sub(_rootPos); // 链轴（根→端球）
    if (_polePos.lengthSq() < 1e-12) return;
    _polePos.normalize();
    _v1.copy(_midPos).sub(_rootPos); // 弯时：肘实测离链轴方向
    _v1.addScaledVector(_polePos, -_v1.dot(_polePos));
    if (_v1.lengthSq() < 1e-8) {
      pole.ball.getWorldPosition(_v1).sub(_rootPos); // 直时：pole 偏好方向
      _v1.addScaledVector(_polePos, -_v1.dot(_polePos));
      if (_v1.lengthSq() < 1e-10) return;
    }
    _v1.normalize();
    _v2.crossVectors(_axis, _v1).normalize(); // Y = 弯折轴（⊥ 弯折面）
    _midPos.subVectors(_endPos, _midPos);     // X = 前臂/小腿轴（肘→腕/踝）
    if (_midPos.lengthSq() < 1e-12) return;
    _midPos.normalize();
    _polePos.crossVectors(_midPos, _v2);      // Z = X×Y
    out.setFromRotationMatrix(_m.makeBasis(_midPos, _v2, _polePos));
  };

  // 肘环增量通道（axisIndex：0 = twist 绕前臂轴，1 = bend 绕弯折轴；angle = 按下以来的累计角，
  // axisWorld = 过肘的冻结拖轴）——
  //  twist：前臂/小腿绕自身纵轴滚转（RollModifier 重放持久角），手/脚位置、肘/膝、上臂/大腿全不动；
  //  bend：拖前前臂（onPress 快照）绕弯折轴转 angle，端球搬到弧上的新位置——纯关节 FK，肘/肩
  //  全程不动，旋转保距（新链距恒 ≤ len1+len2）下一帧 TwoBone 复核自然可达。pole 方向随后按
  //  真相重同步：弯时贴肘真实离轴方向（肘没动，求解器把它留在原地，防残差漂移）
  elbowRings.onRotateDrag = (axisIndex, angle, axisWorld) => {
    if (axisIndex === 0) {
      rollAngle = rollBase + angle;
      rollModifier.setAngle(0, rollAngle);
      return;
    }
    rootObj.getWorldPosition(_rootPos);
    pole.ball.getWorldPosition(_polePos).sub(_rootPos); // 拖前的 pole 偏好方向（拖拽中球不动）
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
    }
  };

  const handle: LimbControlHandle = {
    name: spec.name, kind: 'limb', target, pole, elbowRings, rollModifier, modifier, rings,
    get reach() { return reach; },
    setActive: (a) => { modifier.active = a; },
    setReachScale: (s) => { reachScale = s; applyReach(); },
    setKeepAlive: (k) => { keepAlive = k; applyReach(); },
  };

  return {
    name: spec.name, kind: 'limb',
    targets: [target],
    // 端球参与 move 模式切换；端骨环走主选中体系，肘环走子选中（`${name}:elbow`，与主环互斥）；
    // pole 球两种模式都在场（它还是 TwoBone 的 poleTarget，且是 E 模式选中肘部的唯一入口）：
    // W = 双通道操纵器，E = 可点标记
    moveTargets: [target],
    rotateRings: rings ? [rings] : [],
    subRingGroups: [{ key: 'elbow', rings: [elbowRings] }],
    modifiers,
    onModeChange(mode) {
      pole.setMarkerMode(mode === 'rotate');
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
