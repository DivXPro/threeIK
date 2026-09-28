import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { createSkeletonControls } from '../../src/controls';
import type { LookAtControlHandle, LookAtControlSpec } from '../../src/controls';
import { makeCamera, makeDomStub } from './test-utils';

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
