import { MathUtils, Object3D, Quaternion, Vector3 } from 'three';
import { CCDIkModifier } from '../../modifiers/ik/ccd-ik';
import { CopyTransformModifier } from '../../modifiers/constraints/copy-transform';
import { Modifier } from '../../modifiers/modifier';
import { DragTarget } from '../drag-target';
import { RotateRings } from '../rotate-rings';
import { resolveConeAxis, toVec3, type BuiltControl, type ControlBuildContext, type ControlHandleBase, type ControlSpecBase } from '../types';

export interface LookAtControlSpec extends ControlSpecBase {
  kind: 'lookAt';
  /** CCD 链根（颈） */
  rootBone: string;
  /** CCD 链端（头） */
  endBone: string;
  /** 注视距离（锥 min=max，默认 defaults.lookAtRadius）：注视是纯方向语义，球恒贴脸前 R 处 */
  radius?: number;
  /** 方向锥半角（°，默认 defaults.lookAtAngleDeg）：防拖到脑后头反拧 */
  coneAngleDeg?: number;
  /** 锥轴，默认 'facing'（角色朝向） */
  coneAxis?: 'facing' | Vector3;
  /** 随 rootBone（颈）携带，默认 true */
  carry?: boolean;
  /** CCD 迭代数，默认 10 */
  maxIterations?: number;
  /** 头顶摇杆模式（缺省 false = 球即注视目标）：球显示在头顶上方当摇杆帽，没有任何
   *  「脸追的点」——摇杆偏角经最短弧增量直接驱动头颈分摊旋转（CopyTransform 常开保持，
   *  与 E 环同款机制，W/E 手感统一）。映射约定（飞机杆）：前推低头、后拉仰头、左右推
   *  左右转，偏角 1:1；可推半角 = coneAngleDeg，映射恒在视线锥内。
   *  参照物（不可见 Object3D）是朝向真源：装配时镜像端骨当前姿态（零跳动、roll 保留），
   *  拖球时按最短弧增量更新，松手后保持最终朝向（弯腰等带动头部时视线保持）。
   *  缩放容器天然免疫：整条链路没有距离概念（0.1.2 那类世界/rig 换算坑不复存在）。
   *  radius 在摇杆模式复用为「球离头距离」（显示恒距）；rotateShare 复用为分摊比例 */
  joystick?: boolean;
  /** 凝视轴（端骨局部，默认按「rest 姿势下面部朝向 = 角色 facing」反推）：求解瞄准的是
   *  「端骨姿态 × 凝视轴」这条射线——面部追球；缺省推导对任何当前姿势都零跳动 */
  gazeAxis?: Vector3 | [number, number, number];
  /** 端骨旋转环的分摊比例（0–1）：>0 时本控制点变双通道——W 拖球（CCD 注视），
   *  E 出端骨环（拖环 = 端骨转 (1-share) + 父骨跟转 share，解剖学分节；头环带脖子）。
   *  分摊 modifier 只在环拖拽期间激活（常开会与 CCD 反馈互锁），按 endBone 深度排在自家
   *  CCD 之后（拖拽期间环赢）；松手即关闭，并自动把注视球摆回当前视线上——
   *  CCD 接手后保持拖拽朝向（绕注视轴的纯扭转 roll 球表达不了，松手后丢失） */
  rotateShare?: number;
}

export interface LookAtControlHandle extends ControlHandleBase {
  readonly kind: 'lookAt';
  readonly target: DragTarget;
  /** 求解 modifier：缺省模式 = CCD；joystick 模式 = 朝向保持的 CopyTransform（常开） */
  readonly modifier: Modifier;
  /** 端骨旋转环（rotateShare>0 时存在，否则 null） */
  readonly rings: RotateRings | null;
  setRadius(radius: number): void;
  setConeAngleDeg(deg: number): void;
}

/** 推导端骨局部凝视轴：rest 姿势下面部朝向 = 角色 facing。
 *  rest 全局朝向在 rig 空间,facing 是世界方向,中间隔着 rig 根骨之上(容器)的世界旋转,要换算 */
function deriveGazeAxisLocal(ctx: ControlBuildContext, endBone: string): Vector3 {
  const rig = ctx.rig;
  const restGlobal = rig.getGlobalRestQuaternion(rig.boneIndex(endBone), new Quaternion());
  const container = rig.getBoneAt(0).parent;
  const containerQuat = container ? container.getWorldQuaternion(new Quaternion()) : new Quaternion();
  const facingRig = ctx.facing.clone().applyQuaternion(containerQuat.invert()).normalize();
  return facingRig.applyQuaternion(restGlobal.invert()).normalize();
}

/** 当前视线上的球位（世界）:端骨世界位置 + 端骨世界姿态 × 凝视轴 × R */
function gazeBallPosition(endBoneObj: { getWorldQuaternion(q: Quaternion): Quaternion; getWorldPosition(v: Vector3): Vector3 }, gazeLocal: Vector3, radius: number): Vector3 {
  const gazeWorld = gazeLocal.clone().applyQuaternion(endBoneObj.getWorldQuaternion(new Quaternion()));
  return endBoneObj.getWorldPosition(new Vector3()).addScaledVector(gazeWorld, radius);
}

/** 注视（look-at）控制点：CCD 瞄准「端骨前方 R 处的虚拟凝视点」（extendEndBone 链端延伸）——
 *  面部追球,不是头骨轴指球。初始球缺省 = 当前视线上的点(头前 R 处),装配零跳动。
 *  rotateShare>0 时附端骨分摊旋转环，单控制点双通道（W 球 / E 环），松手自动重坐球 */
export function buildLookAtControl(ctx: ControlBuildContext, spec: LookAtControlSpec): BuiltControl {
  if (spec.joystick) return buildJoystickLookAtControl(ctx, spec);
  const rootBoneObj = ctx.bone(spec.rootBone);
  const endBoneObj = ctx.bone(spec.endBone);
  const share = spec.rotateShare ?? 0;
  const axis = resolveConeAxis(spec.coneAxis, ctx.facing);
  let radius = spec.radius ?? ctx.defaults.lookAtRadius;
  let angleDeg = spec.coneAngleDeg ?? ctx.defaults.lookAtAngleDeg;
  const gazeLocal = spec.gazeAxis
    ? toVec3(spec.gazeAxis).normalize()
    : deriveGazeAxisLocal(ctx, spec.endBone);
  const initial = spec.position
    ? toVec3(spec.position)
    : gazeBallPosition(endBoneObj, gazeLocal, radius);
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xffffff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);
  const chainConfig = () => [{
    rootBone: spec.rootBone,
    endBone: spec.endBone,
    target,
    // 虚拟凝视点:求解瞄准「端骨姿态 × 凝视轴 × R」的链端延伸,与球同距——视线对准即零误差。
    // endBoneLength 是 rig 空间长度:radius 是世界语义,容器带缩放(Y Bot 0.026)时必须换算,
    // 否则球(28 单位外)与凝视点(0.35)不同距,CCD 够不着把头拧去凑——进场即折头
    extendEndBone: true,
    endBoneDirection: 'custom' as const,
    endBoneDirectionVector: gazeLocal,
    endBoneLength: ctx.rig.worldToRigLength(radius),
  }];
  const modifier = new CCDIkModifier(chainConfig(), { maxIterations: spec.maxIterations ?? 10, angularDeltaLimit: Math.PI }); // 同 chain：π = 关闭逐帧转角预算

  // 锥锚 = 端骨(头):球恒在脸前 R 处;锚颈会让「当前视线上的球」被钳离球面、次帧回拉
  const applyCone = () => target.setConeConstraint(endBoneObj, axis, MathUtils.degToRad(angleDeg), radius, radius);

  // ---- 旋转通道（rotateShare>0）：端骨分摊环。gating 与重坐全内聚——控制点自持球与骨 ----
  let rings: RotateRings | null = null;
  let shareModifier: CopyTransformModifier | null = null;
  if (share > 0) {
    rings = new RotateRings({ ringRadius: ctx.defaults.ringRadius, viewRing: false }); // 视角环不发 onDragStart，gating 不激活，隐藏
    rings.setJoint(endBoneObj);
    // 不设 orientationCarry：非拖拽时镜像端骨求解朝向（分摊模式语义，见 bone kind）
    ctx.scene.add(rings);
    shareModifier = new CopyTransformModifier([{
      applyBone: spec.endBone, referenceType: 'object', referenceObject: rings, copyRotation: true, parentShare: share,
    }]);
    shareModifier.active = false; // 只在拖拽期间激活——常开则「环镜像求解结果 + 回写」反馈互锁，CCD 被钉死
    const sm = shareModifier;
    rings.onDragStart = () => {
      sm.active = true;
    };
    rings.onDragEnd = () => {
      sm.active = false;
      // 注视球重坐:摆回当前视线(头前 R 处),过锥钳制管线。
      // 不重坐则 modifier 一关,CCD 下帧把端骨拉回旧球位
      target.moveTo(gazeBallPosition(endBoneObj, gazeLocal, radius));
    };
  }

  const handle: LookAtControlHandle = {
    name: spec.name, kind: 'lookAt', target, modifier, rings,
    setActive: (a) => { modifier.active = a; },
    setRadius: (r) => { radius = r; applyCone(); modifier.setChains(chainConfig()); },
    setConeAngleDeg: (d) => { angleDeg = d; applyCone(); },
  };

  return {
    name: spec.name, kind: 'lookAt',
    targets: [target],
    moveTargets: [target],
    rotateRings: rings ? [rings] : [],
    // CCD 按 rootBone 深度、分摊 modifier 按 endBone 深度——天然排在自家 CCD 之后（拖拽期间环赢）
    modifiers: shareModifier
      ? [{ modifier, rootBone: spec.rootBone }, { modifier: shareModifier, rootBone: spec.endBone }]
      : [{ modifier, rootBone: spec.rootBone }],
    postSolve() {
      applyCone();
      if (spec.carry !== false) target.setCarry(rootBoneObj);
      rings?.update(); // 环初始镜像求解后朝向（分摊基准确立）
    },
    update() {
      rings?.update();
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
      rings?.dispose();
    },
  };
}

// ---- joystick 头顶摇杆模式（无目标点：偏角直驱分摊旋转） ----

// 模块临时量（processModification/update 热路径零分配）
const _j1 = new Vector3();
const _j2 = new Vector3();
const _j3 = new Vector3();
const _j4 = new Vector3();
const _jq = new Quaternion();
const _jd = new Quaternion();
const _jp = new Quaternion();
// 映射函数专用槽（_m 前缀）：与调用方的 out 槽隔离——out 可能与 _j* 别名，
// 内部 scratch 若也用 _j* 会先覆写 out 再误读（映射数学全错）
const _m1 = new Vector3();
const _m2 = new Vector3();

/** 视线方向 → 摇杆球方向（相对头骨，归一）。映射（飞机杆）：偏角 α 1:1；
 *  球水平方位的 facing 分量取反成视线的上下分量（前推低头/后拉仰头），right 分量直通。
 *  输入输出均归一；gaze 与 facing 同向时球在正头顶（α=0，方位退化兜底 up） */
function gazeToBallDir(gaze: Vector3, facing: Vector3, up: Vector3, right: Vector3, out: Vector3): Vector3 {
  const cosA = MathUtils.clamp(gaze.dot(facing), -1, 1);
  const alpha = Math.acos(cosA);
  if (alpha < 1e-6) return out.copy(up);
  // v_g = gaze 相对 facing 的垂直分量（归一）
  _m1.copy(gaze).addScaledVector(facing, -cosA).normalize();
  // 球水平方位 h_b：facing 分量 = −(v_g·up)，right 分量 = v_g·right
  _m2.copy(facing).multiplyScalar(-_m1.dot(up)).addScaledVector(right, _m1.dot(right)).normalize();
  return out.copy(up).multiplyScalar(cosA).addScaledVector(_m2, Math.sin(alpha));
}

/** 摇杆球方向 → 视线方向（上者的逆映射）。球偏角 α → 视线偏角 α（恒 ≤ 锥角，不反拧） */
function ballDirToGaze(ballDir: Vector3, facing: Vector3, up: Vector3, right: Vector3, out: Vector3): Vector3 {
  const cosA = MathUtils.clamp(ballDir.dot(up), -1, 1);
  const alpha = Math.acos(cosA);
  if (alpha < 1e-6) return out.copy(facing);
  // 球水平投影方位 h_b
  _m1.copy(ballDir).addScaledVector(up, -cosA).normalize();
  // v_g：up 分量 = −(h_b·facing)，right 分量 = h_b·right
  _m2.copy(up).multiplyScalar(-_m1.dot(facing)).addScaledVector(right, _m1.dot(right)).normalize();
  return out.copy(facing).multiplyScalar(cosA).addScaledVector(_m2, Math.sin(alpha));
}

/** joystick 模式装配：球显示在头顶半球面（锚端骨、轴世界 up、恒距 radius），推哪儿脸转哪儿。
 *  构造链：不可见参照物（朝向真源）→ 摇杆映射 modifier（球偏离期望位 → 最短弧更新参照物）
 *  → CopyTransform 常开（参照物钉端骨 + 父骨分摊）——全程无 CCD、无目标点、无距离换算 */
function buildJoystickLookAtControl(ctx: ControlBuildContext, spec: LookAtControlSpec): BuiltControl {
  const endBoneObj = ctx.bone(spec.endBone);
  const share = spec.rotateShare ?? 0;
  let radius = spec.radius ?? ctx.defaults.lookAtRadius;
  let angleDeg = spec.coneAngleDeg ?? ctx.defaults.lookAtAngleDeg;
  const gazeLocal = spec.gazeAxis
    ? toVec3(spec.gazeAxis).normalize()
    : deriveGazeAxisLocal(ctx, spec.endBone);
  const facing = ctx.facing; // 装配器构造时已归一
  const up = new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(facing, up).normalize();

  // 参照物（不可见，朝向真源）：初始 = 端骨当前世界姿态——装配零跳动、roll 保留
  const refObj = new Object3D();
  refObj.name = `lookAt-joystick:${spec.name}`;
  endBoneObj.getWorldPosition(_j3);
  refObj.position.copy(_j3);
  endBoneObj.getWorldQuaternion(_jq);
  refObj.quaternion.copy(_jq);
  ctx.scene.add(refObj);

  const writeRefWorldQuat = (worldQ: Quaternion): void => {
    if (refObj.parent) {
      refObj.parent.getWorldQuaternion(_jp).invert();
      refObj.quaternion.copy(_jp.multiply(worldQ));
    } else {
      refObj.quaternion.copy(worldQ);
    }
  };

  /** 当前期望球位（世界）：头骨位 + 由参照物朝向反算的摇杆方向 × radius */
  const expectedBallPos = (out: Vector3): Vector3 => {
    refObj.getWorldQuaternion(_jq);
    _j4.copy(gazeLocal).applyQuaternion(_jq).normalize(); // 当前视线方向
    gazeToBallDir(_j4, facing, up, right, _j2);
    endBoneObj.getWorldPosition(out).addScaledVector(_j2, radius);
    return out;
  };

  // 球初始位 = 当前朝向对应的头顶位（直立 = 正顶；预歪头 = 偏向一侧，即朝向指示器）
  const initial = spec.position
    ? toVec3(spec.position)
    : expectedBallPos(new Vector3());
  const target = new DragTarget(ctx.camera, ctx.dom, initial, spec.color ?? 0xffffff, ctx.dragControl, spec.ballRadius ?? ctx.defaults.ballRadius);
  target.onPress = () => ctx.select(spec.name);
  ctx.scene.add(target);

  // 摇杆钳制：锚头骨、轴世界 up、恒距 radius——球只能在头顶半球面（半角 = coneAngleDeg）滑动
  const applyCone = () => target.setConeConstraint(endBoneObj, up, MathUtils.degToRad(angleDeg), radius, radius);

  /** 摇杆映射（事件驱动）：球位被输入路径改写（拖拽/moveTo/TC 回写）→ 最短弧把参照物
   *  视线对准球映射方向。纯方向信号，头骨平移（弯腰/动画驱动）天然免疫；
   *  update/postSolve 的自摆位也会触发本回调，但映射与期望位互逆——幂等，无反馈 */
  const onBallMoved = (): void => {
    endBoneObj.getWorldPosition(_j1);
    target.getWorldPosition(_j4).sub(_j1).normalize(); // 实际球方向
    ballDirToGaze(_j4, facing, up, right, _j2); // 映射视线方向
    refObj.getWorldQuaternion(_jq);
    _j1.copy(gazeLocal).applyQuaternion(_jq).normalize(); // 当前视线方向
    _jd.setFromUnitVectors(_j1, _j2); // 最短弧：不动 roll
    writeRefWorldQuat(_jq.premultiply(_jd));
  };
  target.onMoved = onBallMoved;

  // 朝向保持 modifier（常开）：端骨钉到参照物朝向 + 父骨分摊（E 环同款 parentShare）。
  // 弯腰等带动头部时把朝向钉回——视线保持；CCD 时代靠球携带达成同效果，语义对齐
  const holdModifier = new CopyTransformModifier([{
    applyBone: spec.endBone, referenceType: 'object', referenceObject: refObj,
    copyRotation: true, parentShare: share,
  }]);

  // ---- E 环通道（rotateShare>0）：拖环时保持让位，松手参照物吸收端骨朝向再接管 ----
  let rings: RotateRings | null = null;
  let shareModifier: CopyTransformModifier | null = null;
  if (share > 0) {
    rings = new RotateRings({ ringRadius: ctx.defaults.ringRadius, viewRing: false });
    rings.setJoint(endBoneObj);
    ctx.scene.add(rings);
    shareModifier = new CopyTransformModifier([{
      applyBone: spec.endBone, referenceType: 'object', referenceObject: rings, copyRotation: true, parentShare: share,
    }]);
    shareModifier.active = false;
    const sm = shareModifier;
    rings.onDragStart = () => {
      holdModifier.active = false; // 双 CopyTransform 同骨会让后者赢，关掉语义更干净
      sm.active = true;
    };
    rings.onDragEnd = () => {
      sm.active = false;
      // 参照物吸收环拖出的最终朝向（含 roll）；球由下帧 update 自动摆到对应偏移
      endBoneObj.getWorldQuaternion(_jq);
      writeRefWorldQuat(_jq);
      holdModifier.active = true;
    };
  }

  const handle: LookAtControlHandle = {
    name: spec.name, kind: 'lookAt', target, modifier: holdModifier, rings,
    setActive: (a) => { holdModifier.active = a; },
    setRadius: (r) => { radius = r; applyCone(); },
    setConeAngleDeg: (d) => { angleDeg = d; applyCone(); },
  };

  // 分摊 modifier 按 endBone 深度——保持常开，环拖拽期间排在后面（环赢）
  const modifiers: BuiltControl['modifiers'] = shareModifier
    ? [{ modifier: holdModifier, rootBone: spec.endBone }, { modifier: shareModifier, rootBone: spec.endBone }]
    : [{ modifier: holdModifier, rootBone: spec.endBone }];

  return {
    name: spec.name, kind: 'lookAt',
    targets: [target],
    moveTargets: [target],
    rotateRings: rings ? [rings] : [],
    // 同深度（endBone）稳定排序保持声明序：映射 → 保持 →（拖拽中的）环
    modifiers,
    postSolve() {
      applyCone();
      rings?.update();
      // 摆球到期望位（装配首帧 = 头顶锚点；预歪头 = 对应偏移）
      target.moveTo(expectedBallPos(_j3));
    },
    update() {
      rings?.update();
      // 每帧摆球到期望位：拖拽中期望位 = 映射来源（同点无害）；非拖拽跟随头骨平移/朝向
      target.moveTo(expectedBallPos(_j3));
    },
    handle,
    dispose() {
      ctx.scene.remove(target);
      target.dispose();
      rings?.dispose();
      refObj.removeFromParent();
    },
  };
}
