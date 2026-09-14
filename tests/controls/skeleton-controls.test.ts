import { describe, it, expect } from 'vitest';
import { Bone, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { createSkeletonControls, registerControlKind } from '../../src/controls';
import type { BoneControlHandle, BuiltControl, ChainControlHandle, ControlHandleBase, LimbControlHandle, RootControlHandle } from '../../src/controls';
import { DragTarget, MARKER_SELECTED_COLOR } from '../../src/controls/drag-target';
import { RotateRings } from '../../src/controls/rotate-rings';
import { makeCamera, makeDomStub, makeFakeDriver } from './test-utils';

function bone(name: string, x: number, y: number, z: number) {
  const b = new Bone();
  b.name = name;
  b.position.set(x, y, z);
  return b;
}

/** 迷你人形：Hips(0,1,0)
 *   ├─ UpLegL(0.1,1,0) → LegL(0.1,0.6,0) → FootL(0.1,0.2,0)   （腿直垂，链长 0.8）
 *   └─ Spine(0,1.15,0) → Neck(0,1.5,0) → Head(0,1.65,0)       （脊柱链长 0.35）
 *        └─ ArmL(0.25,1.45,0) → ForeL(0.55,1.45,0) → HandL(0.85,1.45,0) （臂平伸，链长 0.6）
 */
function buildRig() {
  const container = new Object3D();
  const hips = bone('Hips', 0, 1, 0);
  const upLeg = bone('UpLegL', 0.1, 0, 0); hips.add(upLeg);
  const leg = bone('LegL', 0, -0.4, 0); upLeg.add(leg);
  const foot = bone('FootL', 0, -0.4, 0); leg.add(foot);
  const spine = bone('Spine', 0, 0.15, 0); hips.add(spine);
  const neck = bone('Neck', 0, 0.35, 0); spine.add(neck);
  neck.add(bone('Head', 0, 0.15, 0));
  const arm = bone('ArmL', 0.25, 0.3, 0); spine.add(arm);
  const fore = bone('ForeL', 0.3, 0, 0); arm.add(fore);
  fore.add(bone('HandL', 0.3, 0, 0));
  container.add(hips);
  container.updateMatrixWorld(true);
  return { rig: new SkeletonRig(container), container };
}

function makeCtx(rig: SkeletonRig) {
  const scene = new Scene();
  scene.add(rig.getBoneAt(0).parent ?? rig.getBoneAt(0));
  scene.updateMatrixWorld(true);
  return { scene, camera: makeCamera(0, 1, 4, 0, 1, 0), dom: makeDomStub() };
}

/** 世界坐标 → 桩屏幕坐标（800×600） */
function clientFor(camera: ReturnType<typeof makeCamera>, world: Vector3) {
  const v = world.clone().project(camera);
  return { clientX: ((v.x + 1) / 2) * 800, clientY: ((-v.y + 1) / 2) * 600, pointerId: 1 };
}

const RING_AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/** 直驱旋转 proxy（等价 TC 行为）：beginExternalDrag → 写世界四元数 → updateExternalDrag → endExternalDrag。
 *  proxy 挂在场景顶层（父恒等），quaternion 即世界四元数 */
function driveRing(rings: RotateRings, axisIndex: number, angle: number, steps = 1): void {
  const start = rings.getWorldQuaternion(new Quaternion());
  const axisWorld = RING_AXES[axisIndex]!.clone().applyQuaternion(start);
  rings.beginExternalDrag(axisIndex);
  for (let i = 1; i <= steps; i++) {
    rings.quaternion.copy(new Quaternion().setFromAxisAngle(axisWorld, (angle * i) / steps).multiply(start));
    rings.updateExternalDrag();
  }
  rings.endExternalDrag();
}

/** 拖球当前材质色（标记球选中高亮断言用） */
function ballColor(t: DragTarget): number {
  return (t.ball.material as MeshBasicMaterial).color.getHex();
}

describe('createSkeletonControls', () => {
  it('modifier 按根骨深度排序（声明顺序仅决定同深度次序）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'lookAt', name: 'head', rootBone: 'Neck', endBone: 'Head' },
        { kind: 'limb', name: 'arm', rootBone: 'ArmL', middleBone: 'ForeL', endBone: 'HandL' },
        { kind: 'chain', name: 'spine', rootBone: 'Spine', endBone: 'Neck' },
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false },
        { kind: 'root', name: 'hips', bone: 'Hips' },
      ],
    });
    expect(rig.getModifiers().map((m) => m.constructor.name)).toEqual([
      'RootMotionModifier', // Hips 深度 0
      'FabrikModifier',     // Spine 深度 1（声明先于腿）
      'TwoBoneIkModifier',  // UpLegL 深度 1
      'CCDIkModifier',      // Neck 深度 2（声明先于臂）
      'TwoBoneIkModifier',  // ArmL 深度 2
      'RollModifier',       // LegL 深度 2（腿声明在臂之后）
      'RollModifier',       // ForeL 深度 3
    ]);
    ctl.dispose();
  });

  it('方向型球贴身：pole 球贴肘（弯度仪表）、注视球恒距半径', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'arm', rootBone: 'ArmL', middleBone: 'ForeL', endBone: 'HandL' },
        { kind: 'lookAt', name: 'head', rootBone: 'Neck', endBone: 'Head' },
      ],
    });
    scene.updateMatrixWorld(true);
    const fore = rig.getBoneAt(rig.boneIndex('ForeL'));
    const neck = rig.getBoneAt(rig.boneIndex('Neck'));
    const arm = ctl.get<LimbControlHandle>('arm')!;
    // 臂 rest 伸直：肘钉在链轴上，pole 球贴着肘（仅最小显示偏移 0.02）
    expect(arm.pole.ball.getWorldPosition(new Vector3()).distanceTo(fore.getWorldPosition(new Vector3()))).toBeLessThan(0.03);
    expect(ctl.get('head')!.target!.getWorldPosition(new Vector3()).distanceTo(neck.getWorldPosition(new Vector3()))).toBeCloseTo(0.35, 5);
    ctl.dispose();
  });

  it('位置球收拢进可达域：初始位置超界被钳到 keepAlive 球面上', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        // 手球摆到距肩 0.9（链长 0.6，keepAlive 0.96 → 钳到 0.576）
        { kind: 'limb', name: 'arm', rootBone: 'ArmL', middleBone: 'ForeL', endBone: 'HandL', position: [0.25 + 0.9, 1.45, 0], keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const armBone = rig.getBoneAt(rig.boneIndex('ArmL'));
    const ball = ctl.get<LimbControlHandle>('arm')!.target;
    expect(ball.getWorldPosition(new Vector3()).distanceTo(armBone.getWorldPosition(new Vector3()))).toBeCloseTo(0.6 * 0.96, 5);
    expect(ctl.get<LimbControlHandle>('arm')!.reach).toBeCloseTo(0.6, 5);
    ctl.dispose();
  });

  it('root 控制点驱动根骨位置，球域钳制生效', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [{ kind: 'root', name: 'hips', bone: 'Hips' }],
    });
    const hips = ctl.get<RootControlHandle>('hips')!;
    hips.target.moveTo(new Vector3(0.3, 1, 0)); // 半径 0.4 内
    rig.update(0);
    const hipsBone = rig.getBoneAt(rig.boneIndex('Hips'));
    expect(hipsBone.position.distanceTo(new Vector3(0.3, 1, 0))).toBeLessThan(1e-5);
    hips.target.moveTo(new Vector3(0, 1, 5)); // 超界 → 钳到球面
    expect(hips.target.position.z).toBeCloseTo(0.4, 5);
    ctl.dispose();
  });

  it('携带：移动重心后携带球随锚骨保持偏移，carry:false 的脚钉地', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'root', name: 'hips', bone: 'Hips' },
        { kind: 'limb', name: 'arm', rootBone: 'ArmL', middleBone: 'ForeL', endBone: 'HandL' },
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false },
      ],
    });
    scene.updateMatrixWorld(true);
    const armBone = rig.getBoneAt(rig.boneIndex('ArmL'));
    const armH = ctl.get<LimbControlHandle>('arm')!;
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const distBefore = armH.target.getWorldPosition(new Vector3()).distanceTo(armBone.getWorldPosition(new Vector3()));
    const footBefore = legH.target.position.clone();

    ctl.get<RootControlHandle>('hips')!.target.moveTo(new Vector3(0, 0.8, 0)); // 下蹲 0.2
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    const distAfter = armH.target.getWorldPosition(new Vector3()).distanceTo(armBone.getWorldPosition(new Vector3()));
    expect(distAfter).toBeCloseTo(distBefore, 5); // 偏移保持
    expect(armH.target.position.y).toBeLessThan(1.45 - 0.1); // 手球跟下去了
    expect(legH.target.position.distanceTo(footBefore)).toBeLessThan(1e-6); // 脚钉住
    ctl.dispose();
  });

  it("poleDirection 'auto'：首解后实测中骨局部 pole 向量写入 TwoBone 配置", () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL' },
        { kind: 'limb', name: 'legNoRoll', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', poleDirection: 'none' },
      ],
    });
    const readCfg = (name: string) =>
      (ctl.get(name)!.modifier as unknown as { configs: { poleDirection?: string; poleDirectionVector?: Vector3 }[] }).configs[0]!;
    expect(readCfg('leg').poleDirection).toBe('custom');
    expect(readCfg('leg').poleDirectionVector!.length()).toBeGreaterThan(0.5);
    expect(readCfg('legNoRoll').poleDirection).toBeUndefined();
    ctl.dispose();
  });

  it('pole 双通道·角度：拖球沿环滑调肘朝向——端球不动、弯度不变、膝绕轴转向 pole', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        // keepAlive 0.96 留弯度：完全伸直时膝钉在链轴上，绕轴转向不产生位移，测不出 pole 效果
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    const targetBefore = legH.target.position.clone();
    const midBefore = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());

    // 真指针拖球沿环滑（半径不变 = 纯角度通道）：环心 A = 球的轴上垂足，拖到绕轴 +90° 的等半径点（+x 侧）
    const hip = rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());
    const axis = legH.target.getWorldPosition(new Vector3()).sub(hip).normalize();
    const ballPos = legH.pole.ball.getWorldPosition(new Vector3());
    const centerA = hip.clone().addScaledVector(axis, ballPos.clone().sub(hip).dot(axis));
    const ringP = ballPos.clone().sub(centerA)
      .applyQuaternion(new Quaternion().setFromAxisAngle(axis, Math.PI / 2))
      .add(centerA);
    // 按下选中肘部（attach 到 pole）：TC 接管期间球自身拖拽让位——等价 TC 拖拽走 driver 派发
    dom.fire('pointerdown', clientFor(camera, ballPos));
    expect(legH.pole.isDragging).toBe(false);
    driver.fireDragStart(null);
    expect(legH.pole.isDragging).toBe(true);
    // 模拟 TC 直写球位置：沿环滑到绕轴 +90° 的等半径点（角度通道），reclamp 分解落回
    legH.pole.ball.position.add(
      ringP.clone().sub(legH.pole.ball.getWorldPosition(new Vector3())));
    driver.fireDragChange();
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    // 角度通道：pole 只管朝向——端球（弯度未变）纹丝不动，膝绕链轴摆到 +x 侧
    expect(legH.target.position.distanceTo(targetBefore)).toBeLessThan(1e-6);
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(midBefore.x + 0.02);
    // 球是肘/膝的影子：与膝关节基本重合
    expect(legH.pole.ball.getWorldPosition(new Vector3()).distanceTo(midPos)).toBeLessThan(0.03);
    driver.fireDragEnd();
    expect(legH.pole.isDragging).toBe(false);
    ctl.dispose();
  });

  it('肘部操纵器 W/E 换班：W = pole 球（常驻可拖），E = 肘环（选中后才 attach，未选中 detach）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    // 默认 move：pole 球显示（attach 挂点），未选中 → 操纵器 detach
    expect(legH.pole.visible).toBe(true);
    expect(driver.attachedTo).toBeNull();
    // 点 pole 球 = 选中肘部子目标，attach 切到 pole 球；TC 接管期间球自身拖拽让位
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(driver.attachedTo).toBe(legH.pole.ball);
    expect(legH.pole.isDragging).toBe(false);
    driver.fireDragStart(null);
    expect(legH.pole.isDragging).toBe(true);
    driver.fireDragEnd();
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点 pole 球 = 选中肘部子目标

    // rotate：pole 球退化为可点标记（留场——它是选中肘部的唯一入口）；肘部已选中 → attach 肘环
    //（端骨环不上——两个选中目标互斥）
    ctl.setManipulatorMode('rotate');
    expect(legH.pole.visible).toBe(true);
    expect(driver.attachedTo).toBe(legH.elbowRings);
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(false); // 标记：可点不可拖
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点标记 = 选中肘部
    dom.fire('pointerup', {});

    // 换选主控制点：attach 端骨环、肘环 detach
    ctl.select('leg');
    expect(driver.attachedTo).toBe(legH.rings!);
    // 失焦：detach
    ctl.select(null);
    expect(driver.attachedTo).toBeNull();

    // 切回 move：未选中仍 detach
    ctl.setManipulatorMode('move');
    expect(legH.pole.visible).toBe(true);
    expect(driver.attachedTo).toBeNull();
    ctl.dispose();
  });

  it('肘环·bend（Y 环绕弯折轴）= 伸缩：手绕肘画弧、肘钉住不动（纯肘关节 FK）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');
    ctl.select('leg:elbow'); // 肘环是独立选中目标：选中肘部才上场

    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const knee0 = knee(); // 留弯姿势：(0.1, 0.616, -0.112) 附近
    const footBefore = legH.target.getWorldPosition(new Vector3());
    // 直驱 bend 环（Y 环，绕弯折轴）+90°：前臂在弯折面内收，肘钉住不动
    driveRing(legH.elbowRings, 1, Math.PI / 2);
    converge();

    // 肘钉住：空间位置不变；手画弧收向身后（z 大幅变负、x 不变），前臂长度不变
    expect(knee().distanceTo(knee0)).toBeLessThan(1e-3);
    const foot = legH.target.getWorldPosition(new Vector3());
    expect(foot.distanceTo(footBefore)).toBeGreaterThan(0.1);
    expect(Math.abs(foot.x - 0.1)).toBeLessThan(0.01);
    expect(foot.z).toBeLessThan(-0.4);
    expect(foot.distanceTo(knee())).toBeCloseTo(0.4, 3);
    // pole 与膝真相同步（球虽收起，方向通道不漂移）：球 ≈ 膝
    expect(legH.pole.ball.getWorldPosition(new Vector3()).distanceTo(knee())).toBeLessThan(0.03);
    ctl.dispose();
  });

  it('肘环·帧内连发 move 不丢角度：累计角 × 拖前前臂快照，两次 move 与一次拖到 90° 同效', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');
    ctl.select('leg:elbow'); // 肘环是独立选中目标：选中肘部才上场

    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const knee0 = knee();
    // 帧内连发：两步 45° 之间【不求解】（骨骼位置是拖前快照）——累计角 × 拖前快照不丢角度
    driveRing(legH.elbowRings, 1, Math.PI / 2, 2);
    converge();

    // 若逐事件读骨骼：第二笔 move 会把第一笔的旋转丢掉（净剩 45°，z ≈ −0.30）；
    // 累计角 × 拖前快照：与单次拖到 90° 同效（手弧到 z < −0.4），肘钉住、前臂保长
    expect(knee().distanceTo(knee0)).toBeLessThan(1e-3);
    const foot = legH.target.getWorldPosition(new Vector3());
    expect(foot.z).toBeLessThan(-0.4);
    expect(Math.abs(foot.x - 0.1)).toBeLessThan(0.01);
    expect(foot.distanceTo(knee())).toBeCloseTo(0.4, 3);
    ctl.dispose();
  });

  it('肘环·twist（X 环绕前臂/小腿轴）= 扭转：小腿绕自身纵轴滚，脚/膝位置纹丝不动', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');
    ctl.select('leg:elbow');

    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const foot = () => rig.getBoneAt(rig.boneIndex('FootL')).getWorldPosition(new Vector3());
    const knee0 = knee();
    const foot0 = foot();
    const target0 = legH.target.getWorldPosition(new Vector3());
    const q0 = rig.getBoneAt(rig.boneIndex('LegL')).getWorldQuaternion(new Quaternion());
    const calfAxis = foot0.clone().sub(knee0).normalize();
    // 直驱 twist 环（X 环，绕前臂/小腿轴）+90°：位置通道全不动，只滚朝向
    driveRing(legH.elbowRings, 0, Math.PI / 2);
    converge();

    // 位置通道全程不动：脚、膝、端球都纹丝不动（扭转只滚朝向）
    expect(knee().distanceTo(knee0)).toBeLessThan(1e-6);
    expect(foot().distanceTo(foot0)).toBeLessThan(1e-6);
    expect(legH.target.getWorldPosition(new Vector3()).distanceTo(target0)).toBeLessThan(1e-6);
    // 小腿（中骨）世界朝向 = 拖前往返 × 绕小腿轴 +90°：qDelta ≈ axisAngle(calfAxis, π/2)
    const q1 = rig.getBoneAt(rig.boneIndex('LegL')).getWorldQuaternion(new Quaternion());
    const qDelta = q1.multiply(q0.invert());
    const expected = new Quaternion().setFromAxisAngle(calfAxis, Math.PI / 2);
    expect(qDelta.angleTo(expected)).toBeLessThan(0.05);
    ctl.dispose();
  });

  it('根关节环（rootRotation）·twist：绕大腿轴拧 = 膝钉住、脚绕轴摆，两段骨长与链距全保', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96, rootRotation: true },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');

    // 子选中 `${name}:root` 才 attach 根环；根环在髋关节（标记球常驻选中入口）
    expect(driver.attachedTo).toBeNull();
    ctl.select('leg:root');
    expect(driver.attachedTo).toBe(legH.shoulderRings!); // 与肘环互斥（attach 唯一）
    expect(legH.shoulderMarker!.ball.visible).toBe(true);

    const hip = () => rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());
    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const foot = () => rig.getBoneAt(rig.boneIndex('FootL')).getWorldPosition(new Vector3());
    const hip0 = hip(); const knee0 = knee(); const foot0 = foot();
    const chainDist0 = hip0.distanceTo(foot0);
    // 直驱 twist 环（X 环，绕大腿轴）+90°：膝钉住、脚绕轴摆
    driveRing(legH.shoulderRings!, 0, Math.PI / 2);
    converge();

    // 髋（根）与膝（在大腿轴上）钉住不动；脚绕大腿轴摆了 ~90°；骨长与链距全保
    expect(hip().distanceTo(hip0)).toBeLessThan(1e-3);
    expect(knee().distanceTo(knee0)).toBeLessThan(1e-3);
    expect(foot().distanceTo(foot0)).toBeGreaterThan(0.05);
    expect(foot().distanceTo(knee())).toBeCloseTo(0.4, 3); // 小腿长
    expect(hip().distanceTo(foot())).toBeCloseTo(chainDist0, 3); // 链距（弯度不变）
    ctl.dispose();
  });

  it('根关节环（rootRotation）·swing：绕弯折轴摆 = 膝绕髋画弧、弯度不变、脚跟随（IK 真相同步）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96, rootRotation: true },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');
    ctl.select('leg:root');

    const hip = () => rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());
    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const foot = () => rig.getBoneAt(rig.boneIndex('FootL')).getWorldPosition(new Vector3());
    const hip0 = hip(); const knee0 = knee(); const foot0 = foot();
    const chainDist0 = hip0.distanceTo(foot0);
    // 直驱 swing 环（Y 环，绕弯折轴）+90°：整条腿向前摆平
    driveRing(legH.shoulderRings!, 1, Math.PI / 2);
    converge();

    // 刚体旋转：膝绕髋画弧（大腿长不变）、脚跟随、链距不变（弯度不变）、髋钉住
    expect(hip().distanceTo(hip0)).toBeLessThan(1e-3);
    expect(knee().distanceTo(hip0)).toBeCloseTo(0.4, 3); // 大腿长
    expect(knee().distanceTo(knee0)).toBeGreaterThan(0.05); // 膝真的摆了
    expect(foot().distanceTo(knee())).toBeCloseTo(0.4, 3); // 小腿长
    expect(hip().distanceTo(foot())).toBeCloseTo(chainDist0, 3); // 弯度不变
    // 端球真相同步：球贴着新脚位（IK 下一帧解回同一姿势，不反弹）
    expect(legH.target.getWorldPosition(new Vector3()).distanceTo(foot())).toBeLessThan(0.02);
    ctl.dispose();
  });

  it('根关节环·直链 twist：腿伸直时绕大腿轴拧 = 位置全不动、整链绕链轴滚（pole 通道接管）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        // keepAlive 1 = 完全伸直：髋→膝→脚全在大腿轴上，刚体旋转通道是空操作，
        // twist 只能走 pole 方向旋转（链滚转 = 大腿扭转、膝折痕转向）
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 1, rootRotation: true },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');
    ctl.select('leg:root');

    const hip = () => rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());
    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const foot = () => rig.getBoneAt(rig.boneIndex('FootL')).getWorldPosition(new Vector3());
    const hip0 = hip(); const knee0 = knee(); const foot0 = foot();
    const thigh = rig.getBoneAt(rig.boneIndex('UpLegL'));
    const q0 = thigh.getWorldQuaternion(new Quaternion()).normalize();
    // pole 方向（球世界位置去链轴分量；直链时球绕链轴转的角度 = pole 方向转的角度）
    const poleDirOf = () => {
      const d = legH.pole.ball.getWorldPosition(new Vector3()).sub(hip());
      const a = knee().sub(hip()).normalize();
      return d.addScaledVector(a, -d.dot(a)).normalize();
    };
    const poleDir0 = poleDirOf();
    // 直驱 twist 环（X 环，绕大腿轴）+90°：刚体通道空操作，pole 方向旋转是唯一生效通道
    driveRing(legH.shoulderRings!, 0, Math.PI / 2);
    converge();

    // 三点位置全钉住（都在大腿轴上，刚体通道本就无位移）
    expect(hip().distanceTo(hip0)).toBeLessThan(1e-3);
    expect(knee().distanceTo(knee0)).toBeLessThan(1e-3);
    expect(foot().distanceTo(foot0)).toBeLessThan(1e-3);
    // pole 方向绕链轴转了 ~90°（控制层真相）
    expect(poleDir0.angleTo(poleDirOf())).toBeGreaterThan(Math.PI / 2 - 0.1);
    expect(poleDir0.angleTo(poleDirOf())).toBeLessThan(Math.PI / 2 + 0.1);
    // 大腿骨真的滚了 ~90°（Float32 位姿存储有量级漂移，先归一化再比角）
    const q1 = thigh.getWorldQuaternion(new Quaternion()).normalize();
    expect(q0.angleTo(q1)).toBeGreaterThan(Math.PI / 2 - 0.1);
    expect(q0.angleTo(q1)).toBeLessThan(Math.PI / 2 + 0.1);
    ctl.dispose();
  });

  it('pole 双通道·径向拖 = 弯度：外拽手收回膝弯出（朝向不变），推回轴心腿伸直', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    const hip = rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());
    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const axis = () => legH.target.getWorldPosition(new Vector3()).sub(hip).normalize();
    /** 点在链轴上的垂足（球/膝 ⊥ 轴，垂足即环心） */
    const footOnAxis = (p: Vector3) => hip.clone().addScaledVector(axis(), p.clone().sub(hip).dot(axis()));
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };

    // rest 腿伸直：膝钉在链轴上，球贴着膝（仅最小显示偏移 0.02）
    const ball0 = legH.pole.ball.getWorldPosition(new Vector3());
    expect(ball0.distanceTo(knee())).toBeLessThan(0.03);

    // 径向外拽 0.15：手沿链轴收到 D(ρ)=2√(0.4²−0.15²)≈0.742，膝向 pole 侧（-z）弯出、不甩向
    const center0 = footOnAxis(ball0); // 冻结环心（径向通道的直线锚点）
    const outDir = ball0.clone().sub(center0).normalize(); // 球的离轴方向
    // 按下选中肘部并 attach pole；TC 拖拽走 driver 派发（等价 mouseDown → 直写位置 → objectChange）
    dom.fire('pointerdown', clientFor(camera, ball0));
    driver.fireDragStart(null);
    expect(legH.pole.isDragging).toBe(true);
    // 模拟 TC 直写球位置：沿离轴方向外拽 0.15（径向通道），reclamp 分解触发弯度回调
    legH.pole.ball.position.add(
      center0.clone().addScaledVector(outDir, 0.15).sub(legH.pole.ball.getWorldPosition(new Vector3())));
    driver.fireDragChange();
    converge();
    expect(legH.target.getWorldPosition(new Vector3()).distanceTo(hip)).toBeCloseTo(2 * Math.sqrt(0.16 - 0.0225), 3);
    const midBent = knee();
    expect(midBent.z).toBeLessThan(-0.08);                // 弯出到 pole 侧
    expect(Math.abs(midBent.x - 0.1)).toBeLessThan(0.03); // 不甩向：仍在原弯面内
    // 球贴着膝（弯度仪表）：TwoBone 是解析解，实测半径即用户意图
    expect(legH.pole.ball.getWorldPosition(new Vector3()).distanceTo(midBent)).toBeLessThan(0.05);

    // 推回轴心（瞄准当前环心 = 径向零点）：手伸到全可达 0.8，腿伸直（膝回链轴）。
    // reclamp 用活架分解：轴向分量丢弃，对准当前轴上垂足即半径意图 0
    legH.pole.ball.position.add(
      footOnAxis(legH.pole.ball.getWorldPosition(new Vector3())).sub(legH.pole.ball.getWorldPosition(new Vector3())));
    driver.fireDragChange();
    driver.fireDragEnd();
    converge();
    expect(legH.target.getWorldPosition(new Vector3()).distanceTo(hip)).toBeCloseTo(0.8, 3);
    const midStraight = knee();
    expect(midStraight.clone().sub(footOnAxis(midStraight)).length()).toBeLessThan(0.02);
    expect(legH.pole.isDragging).toBe(false);
    ctl.dispose();
  });

  it('registerControlKind：自定义 kind 走同一装配管线；未知 kind 报 CONFIG_ERROR', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    let sawCtx = false;
    registerControlKind('marker', (ctx, spec) => {
      sawCtx = !!ctx.rig && !!ctx.bone('Hips');
      const target = new DragTarget(ctx.camera, ctx.dom, new Vector3(0, 2, 0), 0x123456, ctx.dragControl);
      ctx.scene.add(target);
      const handle: ControlHandleBase = {
        name: spec.name, kind: 'marker', target,
        modifier: { active: true, influence: 1 } as unknown as ControlHandleBase['modifier'],
        setActive() {},
      };
      const built: BuiltControl = {
        name: spec.name, kind: 'marker', targets: [target], modifiers: [],
        postSolve() {}, handle,
        dispose() { ctx.scene.remove(target); target.dispose(); },
      };
      return built;
    });
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [{ kind: 'marker', name: 'm1' }],
    });
    expect(sawCtx).toBe(true);
    expect(ctl.get('m1')?.kind).toBe('marker');
    expect(() =>
      createSkeletonControls({ rig, scene, camera, dom, controls: [{ kind: 'nope', name: 'x' }] }),
    ).toThrowError(/未知控制点 kind/);
    ctl.dispose();
  });

  it('add/remove/dispose：运行时增删控制点，dispose 清场', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [{ kind: 'root', name: 'hips', bone: 'Hips' }],
    });
    const before = rig.getModifiers().length;
    ctl.add({ kind: 'chain', name: 'spine', rootBone: 'Spine', endBone: 'Neck' });
    expect(rig.getModifiers().length).toBe(before + 1);
    expect(ctl.get('spine')?.kind).toBe('chain');
    // 重名拒绝
    expect(() => ctl.add({ kind: 'chain', name: 'spine', rootBone: 'Spine', endBone: 'Neck' })).toThrowError(/重名/);
    ctl.remove('spine');
    expect(rig.getModifiers().length).toBe(before);
    expect(ctl.get('spine')).toBeUndefined();
    expect(ctl.targets.length).toBe(1);
    ctl.dispose();
    expect(rig.getModifiers().length).toBe(0);
    expect(ctl.targets.length).toBe(0);
    expect(scene.children.filter((c) => c instanceof DragTarget).length).toBe(0);
  });

  it('操纵器模式：双通道控制点球↔环切换，肘部 pole 球↔肘环换班，纯位置控制点（chain）不参战', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        { kind: 'root', name: 'hips', bone: 'Hips', rotation: true },
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true },
        { kind: 'chain', name: 'spine', rootBone: 'Spine', endBone: 'Neck' }, // 纯位置：不参战
      ],
    });
    const hipsH = ctl.get<RootControlHandle>('hips')!;
    const legH = ctl.get<LimbControlHandle>('leg')!;
    expect(hipsH.rings).toBeDefined();
    expect(legH.rings).toBeDefined();
    // 默认 move：未选中 → detach；球可拖（选中即 attach，TC 拖拽经 driver 派发）
    expect(driver.attachedTo).toBeNull();
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(legH.target.isDragging).toBe(false); // attach 后自身拖拽让位
    driver.fireDragStart(null);
    expect(legH.target.isDragging).toBe(true);
    driver.fireDragEnd();
    dom.fire('pointerup', {});
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    driver.fireDragStart(null);
    expect(legH.pole.isDragging).toBe(true); // pole 在 move 模式可拖（轨道球，纯位置控制点）
    driver.fireDragEnd();
    dom.fire('pointerup', {});
    const ballScaleW = legH.target.ball.scale.x; // W 模式球大小基线（W/E 切换不应改变）
    // 环无自身指针交互（无头 proxy，命中归 TransformControls）：点环附近空白不进拖拽
    dom.fire('pointerdown', clientFor(camera, hipsH.rings!.getWorldPosition(new Vector3()).add(new Vector3(0.08, 0.08, 0.08))));
    expect(hipsH.rings!.isDragging).toBe(false);

    // rotate：双通道控制点的球退化成可点标记（不藏、不可拖）；端骨环走主选中、肘环走子选中；
    // pole 球退化为可点标记（上面 move 模式最后拖的是 pole 球，选中 = 'leg:elbow'，故肘环在场、端骨环不上）
    ctl.setManipulatorMode('rotate');
    // 未选中主控制点：attach 的是子选中肘环（选中 = 'leg:elbow'，从上面 move 模式拖 pole 来的）
    expect(driver.attachedTo).toBe(legH.elbowRings);
    expect(legH.target.ball.visible).toBe(true); // 球变标记，不藏
    expect(legH.target.ball.scale.x).toBe(ballScaleW); // 标记化只切可拖性，球大小不变
    expect(legH.pole.visible).toBe(true); // pole 球变标记，不藏（E 模式选中肘部的入口）
    // 标记点击 = 选中，不进入拖拽
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(legH.target.isDragging).toBe(false);
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerup', {});
    expect(driver.attachedTo).toBe(legH.rings!); // 主选中：attach 端骨环
    // 换选肘部子目标：attach 肘环
    ctl.select('leg:elbow');
    expect(driver.attachedTo).toBe(legH.elbowRings);
    // 换选别的控制点：attach 随之切换
    ctl.select('hips');
    expect(driver.attachedTo).toBe(hipsH.rings!);
    // 选中后环可拖（直驱 proxy：begin → isDragging → end）
    hipsH.rings!.beginExternalDrag(1);
    expect(hipsH.rings!.isDragging).toBe(true);
    hipsH.rings!.endExternalDrag();
    // pole 在 rotate 模式是标记：可见可点不可拖；肘环选中后上场可拖（bend 环 ⊥ 弯折轴 ≈+x，取环上 +y 点）
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(false);
    dom.fire('pointerup', {});
    ctl.select('leg:elbow'); // 肘环走子选中体系：上面已换选 hips，拖前选中肘部
    legH.elbowRings.beginExternalDrag(1);
    expect(legH.elbowRings.isDragging).toBe(true);
    legH.elbowRings.endExternalDrag();
    // 纯位置控制点（chain）两种模式都可用：选中即 attach 平移通道，TC 拖拽经 driver 派发
    const spineH = ctl.get<ChainControlHandle>('spine')!;
    dom.fire('pointerdown', clientFor(camera, spineH.target.getWorldPosition(new Vector3())));
    expect(driver.attachedTo).toBe(spineH.target);
    driver.fireDragStart(null);
    expect(spineH.target.isDragging).toBe(true);
    driver.fireDragEnd();
    dom.fire('pointerup', {});

    ctl.setManipulatorMode('move');
    expect(driver.attachedTo).toBe(spineH.target); // 纯位置不受模式影响：仍 attach 平移通道
    expect(legH.target.ball.visible).toBe(true);
    expect(legH.target.ball.scale.x).toBe(ballScaleW); // 切回 W 大小也不变
    ctl.dispose();
  });

  it('点空白失焦：原地松开才取消选中；按下后拖动（转视角）不失焦', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        { kind: 'root', name: 'hips', bone: 'Hips', rotation: true },
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true },
      ],
    });
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const blank = { clientX: 2, clientY: 2, pointerId: 1 }; // 画布角落：射线打不到任何操纵器

    // 点球选中 → 空白处原地点击（按下+直接松开）→ 失焦
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerup', {});
    dom.fire('pointerdown', blank);
    expect(ctl.getSelected()).toBe('leg'); // 按下时还只是待定，不失焦
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe(null); // 原地松开 → 失焦

    // 空白处按下后拖动（转视角操作）→ 松开也不失焦
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerup', {});
    dom.fire('pointerdown', blank);
    dom.fire('pointermove', { clientX: 200, clientY: 200, pointerId: 1 }); // 拖动超阈值
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('leg'); // 拖过 ≠ 点击，保持选中

    // 微小抖动（≤4px）仍算点击 → 失焦
    dom.fire('pointerdown', blank);
    dom.fire('pointermove', { clientX: 4, clientY: 4, pointerId: 1 });
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe(null);

    // pole 球 = 肘部的操纵器：点它选中肘部子目标（不失焦），但不点亮手臂本体的操纵器
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点 pole 球 = 选中肘部
    driver.fireDragStart(null);
    expect(legH.pole.isDragging).toBe(true);
    driver.fireDragEnd();
    dom.fire('pointerup', {});
    // fake 的 fireDragStart 在事件派发外触发，pressClaimed 没被同轮消费（生产环境 TC 的
    // dom 监听先跑、装配器监听同轮清掉）——补一轮空白按下冲掉认领，不影响后续失焦判定
    dom.fire('pointerdown', blank);
    dom.fire('pointerup', {});

    // 未选中状态点 pole：选中肘部子目标，pole 本身照常可拖
    dom.fire('pointerdown', blank);
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe(null);
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点肘球选中肘部（不影响手臂本体）
    driver.fireDragStart(null);
    expect(legH.pole.isDragging).toBe(true); // pole 本身照常可拖（TC 拖拽经 driver 派发）
    driver.fireDragEnd();
    dom.fire('pointerup', {});

    // 标记点击（rotate 模式）同样算认领：选中后不被自己的 pointerdown 反取消
    ctl.setManipulatorMode('rotate');
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg');
    expect(legH.target.isDragging).toBe(false); // 标记：只选中不拖拽
    dom.fire('pointerup', {});
    // 空白点击在 rotate 模式也失焦
    dom.fire('pointerdown', blank);
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe(null);
    ctl.dispose();
  });

  it('旋转通道：拖环写 rings 朝向，CopyTransform 把端骨全局旋转对齐过去（①脚朝向）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true },
      ],
    });
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const foot = rig.getBoneAt(rig.boneIndex('FootL'));
    const before = foot.getWorldQuaternion(new Quaternion());
    // 直驱 proxy：rotate 模式 + 选中后绕世界 Y 转 90°（等价 TC 拖 Y 环）
    ctl.setManipulatorMode('rotate');
    ctl.select('leg'); // 环只在选中后上场（Maya 同款：只显示选中的操纵器）
    scene.updateMatrixWorld(true);
    driveRing(legH.rings!, 1, Math.PI / 2);
    // 收敛：拖环改的是「相对父骨的局部偏移」，装配后的首个完整求解会顺带把链收到
    // pole 就位后的稳定姿势（装配首解时 pole 球未落位，弯度来源不同）——多跑几帧让
    // 环（FK 携带）与求解互相追上
    for (let i = 0; i < 3; i++) {
      rig.update(0);
      scene.updateMatrixWorld(true);
      ctl.update();
    }
    scene.updateMatrixWorld(true);
    const after = foot.getWorldQuaternion(new Quaternion());
    expect(after.angleTo(before)).toBeGreaterThan(0.5); // 明显转动（~90°）
    expect(after.angleTo(legH.rings!.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-4);
    ctl.dispose();
  });

  it('旋转通道·相对跟随：弯膝后脚尖保持相对小腿的局部转角（FK 语义，不钉绝对朝向）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true },
      ],
    });
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const foot = rig.getBoneAt(rig.boneIndex('FootL'));
    scene.updateMatrixWorld(true);
    const localBefore = foot.quaternion.clone();
    const worldBefore = foot.getWorldQuaternion(new Quaternion());

    // 弯膝：端球从正下方拖到前上方，膝盖明显弯曲、小腿世界朝向大变
    legH.target.moveTo(new Vector3(0.1, 0.55, 0.3));
    // 收敛：求解 → 刷新矩阵 → 环按新父骨（小腿）朝向重算 → 再求解把环朝向写回端骨
    for (let i = 0; i < 3; i++) {
      rig.update(0);
      scene.updateMatrixWorld(true);
      ctl.update();
    }
    scene.updateMatrixWorld(true);

    // 世界朝向跟着小腿明显转动（不再钉在绝对朝向）
    expect(foot.getWorldQuaternion(new Quaternion()).angleTo(worldBefore)).toBeGreaterThan(0.1);
    // 局部转角保持 = 相对小腿的角度不变（FK 相对跟随）
    expect(foot.quaternion.angleTo(localBefore)).toBeLessThan(1e-3);
    ctl.dispose();
  });

  it('root 旋转通道：rings 驱动髋骨朝向（②髋朝向），位置通道不受影响', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [{ kind: 'root', name: 'hips', bone: 'Hips', rotation: true }],
    });
    const hipsH = ctl.get<RootControlHandle>('hips')!;
    const hips = rig.getBoneAt(rig.boneIndex('Hips'));
    ctl.setManipulatorMode('rotate');
    scene.updateMatrixWorld(true);
    const center = hipsH.rings!.getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(0.08, 0, 0))));
    expect(hipsH.rings!.isDragging).toBe(false); // 未选中：环不上场、不可命中
    ctl.select('hips'); // 选中后环上场
    // 直驱 proxy 绕世界 Y 转 90°（未选中时的 pointerdown 不可命中断言见上）
    driveRing(hipsH.rings!, 1, Math.PI / 2);
    const posBefore = rig.getBoneAt(rig.boneIndex('Hips')).getWorldPosition(new Vector3());
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    expect(hips.getWorldQuaternion(new Quaternion()).angleTo(hipsH.rings!.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-4);
    // 位置不被 CopyTransform 触碰（copyPosition:false）
    expect(hips.getWorldPosition(new Vector3()).distanceTo(posBefore)).toBeLessThan(1e-6);
    ctl.dispose();
  });

  it('bone 直接掰骨：旋转专用控制点——move 模式不显示，rotate 模式拖环转骨（胸口/肩/脚尖同款）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [{ kind: 'bone', name: 'chest', bone: 'Spine' }],
    });
    const chestH = ctl.get<BoneControlHandle>('chest')!;
    const spine = rig.getBoneAt(rig.boneIndex('Spine'));
    const neck = rig.getBoneAt(rig.boneIndex('Neck'));
    expect(chestH.kind).toBe('bone');
    expect(ctl.targets.length).toBe(1); // 没有位置球，但有一颗常驻标记球（选中入口）

    // move 模式（默认）：未选中 → detach；标记球常驻两种模式
    expect(driver.attachedTo).toBeNull();
    expect(chestH.marker.ball.visible).toBe(true);
    const neckBefore = neck.getWorldPosition(new Vector3());
    scene.updateMatrixWorld(true);
    const center = chestH.rings.getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(0.08, 0, 0))));
    expect(chestH.rings.isDragging).toBe(false);

    // rotate 模式：环仍要选中后才 attach——点标记球选中（标记不可拖，按下即选中）
    ctl.setManipulatorMode('rotate');
    expect(driver.attachedTo).toBeNull();
    dom.fire('pointerdown', clientFor(camera, chestH.marker.getWorldPosition(new Vector3())));
    expect(chestH.marker.isDragging).toBe(false);
    expect(ctl.getSelected()).toBe('chest');
    expect(driver.attachedTo).toBe(chestH.rings);
    dom.fire('pointerup', {});
    // 直驱 X 环绕世界 X 转 90°（Spine 正上方是 Neck，绕 Y 转原地打转看不出位移，绕 X 转 Neck 才被带起来）
    driveRing(chestH.rings, 0, Math.PI / 2);
    const spinePosBefore = spine.getWorldPosition(new Vector3());
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    expect(spine.getWorldQuaternion(new Quaternion()).angleTo(chestH.rings.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-4);
    expect(neck.getWorldPosition(new Vector3()).distanceTo(neckBefore)).toBeGreaterThan(0.1); // 子骨明显被带动
    expect(spine.getWorldPosition(new Vector3()).distanceTo(spinePosBefore)).toBeLessThan(1e-6); // 只拷旋转不碰位置
    ctl.dispose();
  });

  it('bone·markerBone：标记球跟随另一根骨（分流拥挤关节），环与作用骨不动；点标记照常选中', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: makeFakeDriver(),
      controls: [{ kind: 'bone', name: 'neckC', bone: 'Neck', markerBone: 'Head' }],
    });
    const h = ctl.get<BoneControlHandle>('neckC')!;
    scene.updateMatrixWorld(true);
    // 标记球在 Head（分流位置），环心在 Neck（作用骨）
    expect(h.marker.getWorldPosition(new Vector3()).distanceTo(
      rig.getBoneAt(rig.boneIndex('Head')).getWorldPosition(new Vector3()))).toBeLessThan(1e-6);
    expect(h.rings.getWorldPosition(new Vector3()).distanceTo(
      rig.getBoneAt(rig.boneIndex('Neck')).getWorldPosition(new Vector3()))).toBeLessThan(1e-6);
    // 点标记球 = 选中（标记不可拖）
    dom.fire('pointerdown', clientFor(camera, h.marker.getWorldPosition(new Vector3())));
    expect(h.marker.isDragging).toBe(false);
    expect(ctl.getSelected()).toBe('neckC');
    dom.fire('pointerup', {});
    ctl.dispose();
  });

  it('纯旋转控制点（bone）选中即出环不看 W/E；标记球选中变亮黄（大小恒定），取消选中复原', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [{ kind: 'bone', name: 'chest', bone: 'Spine', color: 0x88ddff }],
    });
    const chestH = ctl.get<BoneControlHandle>('chest')!;
    scene.updateMatrixWorld(true);
    // 默认 move 模式、未选中：detach，标记球 0.7 身份尺寸 + 本色
    expect(driver.attachedTo).toBeNull();
    expect(chestH.marker.ball.scale.x).toBeCloseTo(0.7, 6);
    expect(ballColor(chestH.marker)).toBe(0x88ddff);
    // W 模式点标记球：选中 → 立即 attach 环，标记球变亮黄（大小不变）——点没点中一眼可见
    dom.fire('pointerdown', clientFor(camera, chestH.marker.getWorldPosition(new Vector3())));
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('chest');
    expect(driver.attachedTo).toBe(chestH.rings); // 纯旋转：W 模式也 attach 旋转环
    expect(chestH.marker.ball.scale.x).toBeCloseTo(0.7, 6); // 大小恒定：选中不放大
    expect(ballColor(chestH.marker)).toBe(MARKER_SELECTED_COLOR);
    // W 模式下环真的能拖（选中即出环不是摆设）：直驱 begin → isDragging → end
    scene.updateMatrixWorld(true);
    chestH.rings.beginExternalDrag(0);
    expect(chestH.rings.isDragging).toBe(true);
    chestH.rings.endExternalDrag();
    // 取消选中：detach，标记球复原
    ctl.select(null);
    expect(driver.attachedTo).toBeNull();
    expect(chestH.marker.ball.scale.x).toBeCloseTo(0.7, 6);
    expect(ballColor(chestH.marker)).toBe(0x88ddff);
    ctl.dispose();
  });

  it('肩/髋根环（rotationOnly 子目标）W 模式选中即出环；主选中/肘子选中时收起，标记球跟随子选中高亮', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [{ kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96, rootRotation: true }],
    });
    const h = ctl.get<LimbControlHandle>('leg')!;
    const shoulderRings = h.shoulderRings!;
    const shoulderMarker = h.shoulderMarker!;
    scene.updateMatrixWorld(true);
    // 默认 move 模式未选中：detach
    expect(driver.attachedTo).toBeNull();
    // W 模式选中根关节子目标：纯旋转子目标——立即 attach 根环，标记球变亮黄（大小恒定 0.7 身份尺寸）
    ctl.select('leg:root');
    expect(driver.attachedTo).toBe(shoulderRings);
    expect(shoulderMarker.ball.scale.x).toBeCloseTo(0.7, 6);
    expect(ballColor(shoulderMarker)).toBe(MARKER_SELECTED_COLOR);
    // 主选中（腿本体）：attach 端球，肩/髋标记不高亮（高亮跟随子选中，不跟随主选中）
    ctl.select('leg');
    expect(driver.attachedTo).toBe(h.target);
    expect(ballColor(shoulderMarker)).not.toBe(MARKER_SELECTED_COLOR);
    // 肘子选中（双通道）：W 模式 attach pole 球（子 move 通道），根环不串场
    ctl.select('leg:elbow');
    expect(driver.attachedTo).toBe(h.pole.ball);
    ctl.select(null);
    expect(driver.attachedTo).toBeNull();
    expect(shoulderMarker.ball.scale.x).toBeCloseTo(0.7, 6);
    ctl.dispose();
  });
});

describe('attach 路由（fake driver）', () => {
  /** 标准 rig + 三类控制点（双通道 limb / 纯位置 chain / 纯旋转 bone），fake driver 记录 attach */
  function setupWithDriver() {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const driver = makeFakeDriver();
    const ctl = createSkeletonControls({
      rig, scene, camera, dom, manipulator: driver,
      controls: [
        { kind: 'limb', name: '腿L', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96, endRotation: true, rootRotation: true },
        { kind: 'chain', name: '脊柱', rootBone: 'Spine', endBone: 'Neck' },   // 纯位置
        { kind: 'bone', name: '胸口', bone: 'Spine' },                          // 纯旋转
      ],
    });
    const legL = ctl.get<LimbControlHandle>('腿L')!;
    const spine = ctl.get<ChainControlHandle>('脊柱')!;
    const chest = ctl.get<BoneControlHandle>('胸口')!;
    const handles = { legL, spine, chest };
    return { ctl, driver, handles, rig, scene, dom };
  }

  it('move 模式选中双通道主名 → move attach 端球；切 rotate → rotate attach 端骨环', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('腿L');
    expect(driver.mode).toBe('move');
    expect(driver.attachedTo).toBe(handles.legL.target);
    ctl.setManipulatorMode('rotate');
    expect(driver.mode).toBe('rotate');
    expect(driver.attachedTo).toBe(handles.legL.rings);
  });

  it('纯位置控制点（chain）两种模式都 attach 平移通道', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.select('脊柱');
    expect(driver.mode).toBe('move');
    expect(driver.attachedTo).toBe(handles.spine.target);
    ctl.setManipulatorMode('rotate');
    expect(driver.attachedTo).toBe(handles.spine.target); // attach 由通道决定：纯位置不受模式影响
    expect(driver.mode).toBe('move'); // 末次 setMode 按通道重设：重挂平移通道时仍是 move
  });

  it('纯旋转控制点（bone，rotationOnly）W 模式选中也 attach rotate', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('胸口');
    expect(driver.mode).toBe('rotate');
    expect(driver.attachedTo).toBe(handles.chest.rings);
  });

  it('子选中 elbow：W → move attach pole.ball（axes 缺省）；E → rotate attach 肘环（showZ=false, viewRing=false）', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('腿L:elbow');
    expect(driver.mode).toBe('move');
    expect(driver.attachedTo).toBe(handles.legL.pole.ball);
    ctl.setManipulatorMode('rotate');
    expect(driver.mode).toBe('rotate');
    expect(driver.attachedTo).toBe(handles.legL.elbowRings);
    expect(driver.attachOptions?.axes).toEqual([true, true, false]); // 肘环只开 X/Y（扭转/弯折）
    expect(driver.attachOptions?.viewRing).toBe(false);
  });

  it('子选中 root（肩/髋，rotationOnly）：W 模式也 rotate attach 根环', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('腿L:root');
    expect(driver.mode).toBe('rotate');
    expect(driver.attachedTo).toBe(handles.legL.shoulderRings);
  });

  it('取消选中 detach；移除控制点时若 attach 在其对象上先 detach', () => {
    const { ctl, driver } = setupWithDriver();
    ctl.select('腿L');
    expect(driver.attachedTo).not.toBeNull();
    ctl.select(null);
    expect(driver.attachedTo).toBeNull();
    ctl.select('腿L');
    ctl.remove('腿L');
    expect(driver.attachedTo).toBeNull();
  });

  it('TC 拖拽平移经 reclamp：外部直写位置过钳制回写；endExternalDrag 恢复拖拽态', () => {
    const { ctl, driver, handles, rig, scene } = setupWithDriver();
    ctl.select('脊柱'); // chain，可达钳制生效（首解后）
    const t = handles.spine.target;
    const spineBone = rig.getBoneAt(rig.boneIndex('Spine'));
    driver.fireDragStart('X');
    expect(t.isDragging).toBe(true);
    t.position.set(99, 0, 0); // 模拟 TC 直写（球挂场景顶层，局部 = 世界）
    driver.fireDragChange();  // → reclamp：收拢回可达球面
    scene.updateMatrixWorld(true);
    expect(t.getWorldPosition(new Vector3()).distanceTo(spineBone.getWorldPosition(new Vector3())))
      .toBeLessThanOrEqual(handles.spine.reach + 1e-6);
    driver.fireDragEnd();
    expect(t.isDragging).toBe(false);
  });

  it('TC 拖拽旋转增量：rotate 模式肘环 fireDragStart("Y") → 快照捕获、fireDragChange 提取累计角', () => {
    const { ctl, driver, handles, rig, scene } = setupWithDriver();
    const legH = handles.legL;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();
    ctl.setManipulatorMode('rotate');
    ctl.select('腿L:elbow');

    const knee = () => rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const knee0 = knee();
    const foot0 = legH.target.getWorldPosition(new Vector3());
    // 模拟 TC 拖 Y 环 +90°：fireDragStart 捕获快照 → 直写 proxy 世界四元数 → fireDragChange 累计
    driver.fireDragStart('Y');
    const rings = legH.elbowRings;
    const start = rings.getWorldQuaternion(new Quaternion());
    const axisWorld = new Vector3(0, 1, 0).applyQuaternion(start);
    rings.quaternion.copy(new Quaternion().setFromAxisAngle(axisWorld, Math.PI / 2).multiply(start));
    driver.fireDragChange();
    driver.fireDragEnd();
    converge();

    // bend 语义（与「肘环·bend」同断言）：脚绕膝画弧、肘钉住不动、前臂保长
    expect(knee().distanceTo(knee0)).toBeLessThan(1e-3);
    const foot = legH.target.getWorldPosition(new Vector3());
    expect(foot.distanceTo(foot0)).toBeGreaterThan(0.1);
    expect(foot.distanceTo(knee())).toBeCloseTo(0.4, 3);
  });

  it('driver onDragStart 置 pressClaimed：拖拽开始的 pointerdown 不触发空白失焦', () => {
    const { ctl, driver, dom } = setupWithDriver();
    ctl.select('腿L');
    driver.fireDragStart('X');
    dom.fire('pointerdown', {}); // 同一轮按下（真实环境 TC 的 dom 监听先跑）
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('腿L');
  });
});
