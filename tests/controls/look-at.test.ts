import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { createSkeletonControls } from '../../src/controls';
import type { LookAtControlHandle, LookAtControlSpec } from '../../src/controls';
import { makeCamera, makeDomStub, makeFakeDriver } from './test-utils';

/** 迷你骨架:Hips(0,1,0) → Spine(0,1.15,0) → Neck(0,1.5,0) → Head(0,1.65,0),全竖直,面朝 +Z */
function buildRig() {
  const container = new Object3D();
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.15, 0); hips.add(spine);
  const neck = new Bone(); neck.name = 'Neck'; neck.position.set(0, 0.35, 0); spine.add(neck);
  const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.15, 0); neck.add(head);
  container.add(hips);
  container.updateMatrixWorld(true);
  return { rig: new SkeletonRig(container), container, neck, head };
}

function makeCtx(container: Object3D) {
  const scene = new Scene();
  scene.add(container);
  scene.updateMatrixWorld(true);
  return { scene, camera: makeCamera(0, 1.6, 4, 0, 1.2, 0), dom: makeDomStub() };
}

const FACING = new Vector3(0, 0, 1);

/** Y Bot 放置形态:骨骼链在等比缩放容器里(模型单位 = 世界/scale,如 0.026 → 38.5×) */
function buildScaledRig(scale = 0.026) {
  const m = 1 / scale;
  const container = new Object3D();
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1 * m, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.15 * m, 0); hips.add(spine);
  const neck = new Bone(); neck.name = 'Neck'; neck.position.set(0, 0.35 * m, 0); spine.add(neck);
  const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.15 * m, 0); neck.add(head);
  container.scale.setScalar(scale);
  container.add(hips);
  container.updateMatrixWorld(true);
  return { rig: new SkeletonRig(container), container, neck, head };
}

/** 头骨世界四元数的骨轴(+Y)偏离竖直的角度(度) */
function tiltDeg(bone: Bone): number {
  const up = new Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new Quaternion()));
  return (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
}

/** 两方向夹角(度) */
function dirAngleDeg(a: Vector3, b: Vector3): number {
  const d = a.clone().normalize().dot(b.clone().normalize());
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

function assemble(rig: SkeletonRig, ctx: ReturnType<typeof makeCtx>, spec: Partial<LookAtControlSpec> = {}) {
  return createSkeletonControls({
    rig,
    scene: ctx.scene,
    camera: ctx.camera,
    dom: ctx.dom,
    facing: FACING.clone(),
    hotkeys: false,
    controls: [
      { kind: 'lookAt', name: 'head', rootBone: 'Neck', endBone: 'Head', ...spec } as LookAtControlSpec,
    ],
  });
}

describe('lookAt 注视语义:面部追球,进场零跳动', () => {
  it('装配 + 逐帧求解不改变 T 型头颈姿势(缺省球位)', () => {
    const { rig, container, neck, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    expect(tiltDeg(neck)).toBeLessThan(0.5);
    expect(tiltDeg(head)).toBeLessThan(0.5);
    ctl.dispose();
  });

  it('注视球缺省生成在面部朝向射线上(头前 R 处,非脖子正前方)', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    const h = ctl.get<LookAtControlHandle>('head')!;
    const ballPos = h.target.getWorldPosition(new Vector3());
    const headPos = head.getWorldPosition(new Vector3());
    // 球在头前(facing 方向)而非颈前;与头骨距离 = lookAtRadius(0.35)
    expect(dirAngleDeg(ballPos.clone().sub(headPos), FACING)).toBeLessThan(2);
    expect(ballPos.distanceTo(headPos)).toBeCloseTo(0.35, 3);
    ctl.dispose();
  });

  it('拖球后面部朝向追球(而不是头骨轴指向球)', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    const h = ctl.get<LookAtControlHandle>('head')!;
    const headPos = () => head.getWorldPosition(new Vector3());
    // 把球移到脸右侧偏上(仍在 105° 锥内)
    const goal = headPos().add(new Vector3(0.25, 0.1, 0.3));
    h.target.moveTo(goal);
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gaze = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    const toBall = h.target.getWorldPosition(new Vector3()).sub(headPos());
    expect(dirAngleDeg(gaze, toBall)).toBeLessThan(3);
    // 回归:旧语义会把头骨轴(+Y,头顶)对准球——新语义下两者应相差约 90°
    const crown = new Vector3(0, 1, 0).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    expect(dirAngleDeg(crown, toBall)).toBeGreaterThan(45);
    ctl.dispose();
  });

  it('球与头骨保持恒距(锥钳制以头为锚)', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    const h = ctl.get<LookAtControlHandle>('head')!;
    h.target.moveTo(head.getWorldPosition(new Vector3()).add(new Vector3(0.3, -0.05, 0.2)));
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const d = h.target.getWorldPosition(new Vector3()).distanceTo(head.getWorldPosition(new Vector3()));
    expect(d).toBeCloseTo(0.35, 2);
    ctl.dispose();
  });

  it('显式 gazeAxis(骨局部)覆盖默认推导', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    // 用头顶(+Y)当注视轴:初始球应在头顶正上方 R 处
    const ctl = assemble(rig, ctx, { gazeAxis: new Vector3(0, 1, 0) });
    const h = ctl.get<LookAtControlHandle>('head')!;
    const ballPos = h.target.getWorldPosition(new Vector3());
    const headPos = head.getWorldPosition(new Vector3());
    expect(dirAngleDeg(ballPos.clone().sub(headPos), new Vector3(0, 1, 0))).toBeLessThan(2);
    ctl.dispose();
  });

  it('模型已摆过姿势再装配:球仍生成在当前视线上(零跳动)', () => {
    const { rig, container, neck, head } = buildRig();
    // 先把头往左拧 40°(模拟带着 poseOverride 进场)
    head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (40 * Math.PI) / 180);
    container.updateMatrixWorld(true);
    const ctx = makeCtx(container);
    const q0 = head.getWorldQuaternion(new Quaternion());
    const ctl = assemble(rig, ctx);
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const q1 = head.getWorldQuaternion(new Quaternion());
    expect((q0.angleTo(q1) * 180) / Math.PI).toBeLessThan(0.5);
    // 球应落在拧转后的视线上:facing 绕 Y 转 40°
    const gazeDir = FACING.clone().applyAxisAngle(new Vector3(0, 1, 0), (40 * Math.PI) / 180);
    const ballDir = ctl.get<LookAtControlHandle>('head')!.target.getWorldPosition(new Vector3())
      .sub(head.getWorldPosition(new Vector3()));
    expect(dirAngleDeg(ballDir, gazeDir)).toBeLessThan(2);
    ctl.dispose();
  });

  it('容器等比缩放(Y Bot 0.026 放置形态):装配 + 逐帧求解零跳动', () => {
    const { rig, container, neck, head } = buildScaledRig(0.026);
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    // 回归:endBoneLength 若按世界单位进 rig 空间,球(28 单位外)与虚拟凝视点(0.35)
    // 不同距,CCD 够不着把头拧去凑——0.1.1 在 Y Bot 上折 ~23°
    expect(tiltDeg(neck)).toBeLessThan(0.5);
    expect(tiltDeg(head)).toBeLessThan(0.5);
    ctl.dispose();
  });

  it('容器等比缩放:球与头骨世界距离恒为半径', () => {
    const { rig, container, head } = buildScaledRig(0.026);
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    const h = ctl.get<LookAtControlHandle>('head')!;
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const d = h.target.getWorldPosition(new Vector3()).distanceTo(head.getWorldPosition(new Vector3()));
    expect(d).toBeCloseTo(0.35, 2);
    ctl.dispose();
  });

  it('容器等比缩放:拖球后面部追球收敛(非拧头凑球)', () => {
    const { rig, container, head } = buildScaledRig(0.026);
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx);
    const h = ctl.get<LookAtControlHandle>('head')!;
    const headPos = () => head.getWorldPosition(new Vector3());
    const goal = headPos().add(new Vector3(0.25, 0.1, 0.3));
    h.target.moveTo(goal);
    for (let i = 0; i < 20; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gaze = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    const toBall = h.target.getWorldPosition(new Vector3()).sub(headPos());
    expect(dirAngleDeg(gaze, toBall)).toBeLessThan(3);
    ctl.dispose();
  });
});

/** joystick 模式:球显示在头顶当摇杆帽,没有任何「脸追的点」——摇杆偏角经最短弧增量
 *  直接驱动头颈分摊旋转(CopyTransform 常开保持,与 E 环同款机制)。映射约定(飞机杆):
 *  前推低头、后拉仰头、左右推左右转,偏角 1:1;映射恒在视线锥内(锥角即摇杆可推半角) */
describe('lookAt joystick 头顶摇杆模式:无目标点,偏角直驱分摊旋转', () => {
  const UP = new Vector3(0, 1, 0);
  /** 面朝 +Z 时的右手边:facing × up = -X */
  const RIGHT = new Vector3(-1, 0, 0);

  it('装配零跳动:直立骨架逐帧求解头颈不动,球显示在头顶正上方', () => {
    const { rig, container, neck, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx, { joystick: true });
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    expect(tiltDeg(neck)).toBeLessThan(0.5);
    expect(tiltDeg(head)).toBeLessThan(0.5);
    const h = ctl.get<LookAtControlHandle>('head')!;
    const headPos = head.getWorldPosition(new Vector3());
    const ballDir = h.target.getWorldPosition(new Vector3()).sub(headPos);
    expect(dirAngleDeg(ballDir, UP)).toBeLessThan(2);
    expect(ballDir.length()).toBeCloseTo(0.35, 3);
    ctl.dispose();
  });

  it('预歪头装配零跳动,球偏在头偏向的一侧(球位 = 朝向指示器)', () => {
    const { rig, container, head } = buildRig();
    // 头向左拧 40°(+Y 轴旋转把 gaze 从 +Z 带向 +X)
    head.quaternion.setFromAxisAngle(UP, (40 * Math.PI) / 180);
    container.updateMatrixWorld(true);
    const ctx = makeCtx(container);
    const q0 = head.getWorldQuaternion(new Quaternion());
    const ctl = assemble(rig, ctx, { joystick: true });
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const q1 = head.getWorldQuaternion(new Quaternion());
    expect((q0.angleTo(q1) * 180) / Math.PI).toBeLessThan(0.5);
    // 球应在头顶偏向 +X 一侧,偏离正顶的角度 ≈ 头的偏角 40°
    const h = ctl.get<LookAtControlHandle>('head')!;
    const ballDir = h.target.getWorldPosition(new Vector3())
      .sub(head.getWorldPosition(new Vector3())).normalize();
    expect(dirAngleDeg(ballDir, UP)).toBeGreaterThan(38);
    expect(dirAngleDeg(ballDir, UP)).toBeLessThan(42);
    const horiz = new Vector3(ballDir.x, 0, ballDir.z).normalize();
    expect(dirAngleDeg(horiz, new Vector3(1, 0, 0))).toBeLessThan(3);
    ctl.dispose();
  });

  it('前推低头:球向 facing 方向推 30°,面部朝下偏 30°(1:1)', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx, { joystick: true });
    const h = ctl.get<LookAtControlHandle>('head')!;
    const a = (30 * Math.PI) / 180;
    const goal = head.getWorldPosition(new Vector3())
      .addScaledVector(UP, Math.cos(a) * 0.35)
      .addScaledVector(FACING, Math.sin(a) * 0.35);
    h.target.moveTo(goal);
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gaze = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    const expected = FACING.clone().multiplyScalar(Math.cos(a)).addScaledVector(UP, -Math.sin(a));
    expect(dirAngleDeg(gaze, expected)).toBeLessThan(2);
    ctl.dispose();
  });

  it('右推右转:球向右手边推 30°,面部右转 30°', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx, { joystick: true });
    const h = ctl.get<LookAtControlHandle>('head')!;
    const a = (30 * Math.PI) / 180;
    const goal = head.getWorldPosition(new Vector3())
      .addScaledVector(UP, Math.cos(a) * 0.35)
      .addScaledVector(RIGHT, Math.sin(a) * 0.35);
    h.target.moveTo(goal);
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gaze = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    const expected = FACING.clone().multiplyScalar(Math.cos(a)).addScaledVector(RIGHT, Math.sin(a));
    expect(dirAngleDeg(gaze, expected)).toBeLessThan(2);
    ctl.dispose();
  });

  it('松手后保持:base 姿势弯腰,头世界朝向仍钉在拖拽结果上(视线保持)', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx, { joystick: true, rotateShare: 0.4 });
    const h = ctl.get<LookAtControlHandle>('head')!;
    const a = (30 * Math.PI) / 180;
    const goal = head.getWorldPosition(new Vector3())
      .addScaledVector(UP, Math.cos(a) * 0.35)
      .addScaledVector(FACING, Math.sin(a) * 0.35);
    h.target.moveTo(goal);
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gazeAfterDrag = new Vector3(0, 0, 1)
      .applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    // 模拟弯腰:脊柱 base 前弯 30°(其他控制点/外部改姿势的等价物)
    rig.setBasePoseRotation(
      rig.boneIndex('Spine'),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (30 * Math.PI) / 180),
    );
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gazeAfterBend = new Vector3(0, 0, 1)
      .applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    expect(dirAngleDeg(gazeAfterBend, gazeAfterDrag)).toBeLessThan(2);
    ctl.dispose();
  });

  it('缩放容器(Y Bot 0.026):装配零跳动——无距离概念,天然免疫 0.1.2 那类坑', () => {
    const { rig, container, neck, head } = buildScaledRig(0.026);
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx, { joystick: true });
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    expect(tiltDeg(neck)).toBeLessThan(0.5);
    expect(tiltDeg(head)).toBeLessThan(0.5);
    ctl.dispose();
  });

  it('锥钳制:球推过 105° 被钳住,头不反拧(gaze 不超出视线锥)', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const ctl = assemble(rig, ctx, { joystick: true });
    const h = ctl.get<LookAtControlHandle>('head')!;
    // 往头的后下方推(与 up 夹角 150°,超出 105° 锥)
    const a = (150 * Math.PI) / 180;
    const goal = head.getWorldPosition(new Vector3())
      .addScaledVector(UP, Math.cos(a) * 0.35)
      .addScaledVector(FACING, -Math.sin(a) * 0.35);
    h.target.moveTo(goal);
    for (let i = 0; i < 10; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const ballDir = h.target.getWorldPosition(new Vector3())
      .sub(head.getWorldPosition(new Vector3()));
    expect(dirAngleDeg(ballDir, UP)).toBeLessThanOrEqual(105.5);
    const gaze = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    expect(dirAngleDeg(gaze, FACING)).toBeLessThanOrEqual(106);
    ctl.dispose();
  });

  it('roll 保留:预歪头(绕视线轴 roll 25°)装配不被抹平,球仍在正头顶', () => {
    const { rig, container, head } = buildRig();
    head.quaternion.setFromAxisAngle(FACING, (25 * Math.PI) / 180);
    container.updateMatrixWorld(true);
    const ctx = makeCtx(container);
    const q0 = head.getWorldQuaternion(new Quaternion());
    const ctl = assemble(rig, ctx, { joystick: true });
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const q1 = head.getWorldQuaternion(new Quaternion());
    expect((q0.angleTo(q1) * 180) / Math.PI).toBeLessThan(0.5);
    // roll 不改变视线方向:球仍在正头顶
    const h = ctl.get<LookAtControlHandle>('head')!;
    const ballDir = h.target.getWorldPosition(new Vector3())
      .sub(head.getWorldPosition(new Vector3()));
    expect(dirAngleDeg(ballDir, UP)).toBeLessThan(2);
    ctl.dispose();
  });

  it('E 环衔接:拖环低头 20° 环赢;松手后参照物吸收朝向,保持接管不回弹,球重摆到前推指示位', () => {
    const { rig, container, head } = buildRig();
    const ctx = makeCtx(container);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene: ctx.scene, camera: ctx.camera, dom: ctx.dom,
      facing: FACING.clone(), hotkeys: false, manipulator: driver,
      controls: [
        { kind: 'lookAt', name: 'head', rootBone: 'Neck', endBone: 'Head', joystick: true, rotateShare: 0.4 } as LookAtControlSpec,
      ],
    });
    const h = ctl.get<LookAtControlHandle>('head')!;
    ctl.select('head');
    ctl.setManipulatorMode('rotate');
    expect(driver.attachedTo).toBe(h.rings);
    // TC 拖环:低头 20°(rings 挂场景顶层,局部 = 世界;绕 +X 正转把 +Z 带向 −Y)
    const a = (20 * Math.PI) / 180;
    driver.fireDragStart('X');
    h.rings!.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), a);
    driver.fireDragChange();
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const expected = FACING.clone().multiplyScalar(Math.cos(a)).addScaledVector(UP, -Math.sin(a));
    const gazeDragged = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    expect(dirAngleDeg(gazeDragged, expected)).toBeLessThan(2);
    // 松手:保持接管,朝向不回弹
    driver.fireDragEnd();
    for (let i = 0; i < 5; i++) { rig.update(1 / 60); ctl.update(); }
    ctx.scene.updateMatrixWorld(true);
    const gazeAfter = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    expect(dirAngleDeg(gazeAfter, expected)).toBeLessThan(2);
    // 球重摆到前推 20° 的指示位(头顶偏 facing 方向)
    const ballDir = h.target.getWorldPosition(new Vector3())
      .sub(head.getWorldPosition(new Vector3())).normalize();
    expect(dirAngleDeg(ballDir, UP)).toBeGreaterThan(18);
    expect(dirAngleDeg(ballDir, UP)).toBeLessThan(22);
    const horiz = new Vector3(ballDir.x, 0, ballDir.z).normalize();
    expect(dirAngleDeg(horiz, FACING)).toBeLessThan(3);
    ctl.dispose();
  });
});
