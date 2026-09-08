import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { createSkeletonControls, registerControlKind } from '../../src/controls';
import type { BoneControlHandle, BuiltControl, ChainControlHandle, ControlHandleBase, LimbControlHandle, RootControlHandle } from '../../src/controls';
import { DragTarget } from '../../src/controls/drag-target';
import { makeCamera, makeDomStub } from './test-utils';

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

/** 环命中取有效半径（设定半径 × 屏幕恒定大小缩放；未跑 ctl.update 时 scale=1） */
function ringR(rings: { ringRadius: number; scale: { x: number } }): number {
  return rings.ringRadius * rings.scale.x;
}

describe('createSkeletonControls', () => {
  it('modifier 按根骨深度排序（声明顺序仅决定同深度次序）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
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
    dom.fire('pointerdown', clientFor(camera, ballPos));
    expect(legH.pole.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, ringP));
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    // 角度通道：pole 只管朝向——端球（弯度未变）纹丝不动，膝绕链轴摆到 +x 侧
    expect(legH.target.position.distanceTo(targetBefore)).toBeLessThan(1e-6);
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(midBefore.x + 0.02);
    // 球是肘/膝的影子：与膝关节基本重合
    expect(legH.pole.ball.getWorldPosition(new Vector3()).distanceTo(midPos)).toBeLessThan(0.03);
    dom.fire('pointerup', {});
    expect(legH.pole.isDragging).toBe(false);
    ctl.dispose();
  });

  it('肘部操纵器 W/E 换班：W = pole 球（常驻可拖），E = 肘环（选中后才上场，未选中全收）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    // 默认 move：pole 球显示可拖，肘环收起
    expect(legH.pole.visible).toBe(true);
    expect(legH.elbowRings.visible).toBe(false);
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true);
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点 pole 球 = 选中肘部子目标

    // rotate：pole 球退化为可点标记（留场——它是选中肘部的唯一入口）；肘部已选中 → 肘环上场
    //（端骨环不上——两个选中目标互斥）
    ctl.setManipulatorMode('rotate');
    expect(legH.pole.visible).toBe(true);
    expect(legH.elbowRings.visible).toBe(true);
    expect(legH.rings!.visible).toBe(false);
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(false); // 标记：可点不可拖
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点标记 = 选中肘部
    dom.fire('pointerup', {});

    // 换选主控制点：端骨环上场、肘环收起
    ctl.select('leg');
    expect(legH.elbowRings.visible).toBe(false);
    expect(legH.rings!.visible).toBe(true);
    // 失焦：全部收起
    ctl.select(null);
    expect(legH.elbowRings.visible).toBe(false);
    expect(legH.rings!.visible).toBe(false);

    // 切回 move：球回环收
    ctl.setManipulatorMode('move');
    expect(legH.pole.visible).toBe(true);
    expect(legH.elbowRings.visible).toBe(false);
    ctl.dispose();
  });

  it('肘环·bend（Y 环绕弯折轴）= 伸缩：手绕肘画弧、肘钉住不动（纯肘关节 FK）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
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
    // bend 环 ⊥ 弯折轴（此姿势 ≈+x）：环上 +y 点拖到 +z 点 = 绕弯折轴 +90°（前臂在弯折面内收）
    const r = ringR(legH.elbowRings);
    dom.fire('pointerdown', clientFor(camera, knee0.clone().add(new Vector3(0, r, 0))));
    expect(legH.elbowRings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, knee0.clone().add(new Vector3(0, 0, r))));
    dom.fire('pointerup', {});
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
      rig, scene, camera, dom,
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
    // bend 环（⊥ 弯折轴 ≈+x）：+y 点 → 45° 点 → +z 点，两次 move 之间【不求解】（骨骼位置是拖前快照）
    const r = ringR(legH.elbowRings);
    const p45 = knee0.clone().add(new Vector3(0, r / Math.SQRT2, r / Math.SQRT2));
    const p90 = knee0.clone().add(new Vector3(0, 0, r));
    dom.fire('pointerdown', clientFor(camera, knee0.clone().add(new Vector3(0, r, 0))));
    expect(legH.elbowRings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, p45));
    dom.fire('pointermove', clientFor(camera, p90));
    dom.fire('pointerup', {});
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
      rig, scene, camera, dom,
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
    // twist 环 ⊥ 小腿轴（膝→踝）：环上两个相距 +90° 的点。注意避开两环交点（坐标架 ±Z 同时
    // 落在 twist/bend 两环上）：起始点偏向 bend 轴半格（仍 ⊥ 小腿轴），防止命中打成平手
    const calfAxis = foot0.clone().sub(knee0).normalize();
    const r = ringR(legH.elbowRings);
    const u1 = new Vector3().crossVectors(calfAxis, new Vector3(1, 0, 0)).normalize();
    const u2 = new Vector3().crossVectors(calfAxis, u1);
    const v0 = u1.clone().addScaledVector(u2, 0.5).normalize();
    const v1 = new Vector3().crossVectors(calfAxis, v0); // v0 绕小腿轴 +90°
    dom.fire('pointerdown', clientFor(camera, knee0.clone().addScaledVector(v0, r)));
    expect(legH.elbowRings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, knee0.clone().addScaledVector(v1, r)));
    dom.fire('pointerup', {});
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

  it('肘部轴箭头：W 模式选中肘部才上场，拖 X 箭头单轴挪球（落回轨道分解朝向+弯度），E 模式收起', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, keepAlive: 0.96 },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    // 箭头视图（私有字段，测试直读）
    const arrows = (legH.pole as unknown as { arrows: { group: Object3D; visible: boolean } }).arrows;
    const converge = () => { for (let i = 0; i < 4; i++) { rig.update(0); ctl.update(); scene.updateMatrixWorld(true); } };
    converge();

    // 未选中 / 选中手臂本体：箭头都不上场；选中肘部（W 模式）：上场
    expect(arrows.visible).toBe(false);
    ctl.select('leg');
    expect(arrows.visible).toBe(false);
    ctl.select('leg:elbow');
    converge(); // place() 摆好箭头位置/缩放
    expect(arrows.visible).toBe(true);

    // 拖 +X 箭头（move 带 y/z 抖动）：球严格沿世界 X 单轴移动，膝盖真被带动（操纵器驱动链）
    const knee0 = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const ball0 = legH.pole.ball.getWorldPosition(new Vector3());
    const lenW = arrows.group.scale.x;
    dom.fire('pointerdown', clientFor(camera, ball0.clone().add(new Vector3(lenW * 0.6, 0, 0))));
    expect(legH.pole.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, ball0.clone().add(new Vector3(lenW * 0.6 + 0.15, 0.4, 0.4))));
    dom.fire('pointerup', {});
    converge();
    const ball1 = legH.pole.ball.getWorldPosition(new Vector3());
    expect(ball1.x - ball0.x).toBeGreaterThan(0.05); // 主位移沿 X
    // 单轴语义：z 严格不变（拖轴 ⊥ 竖直链轴，z 分量在冻结架上原样保留）；
    // y 不断言——弯度变化会让环心沿链轴（±y）滑动，是径向通道的合法副产物
    expect(Math.abs(ball1.z - ball0.z)).toBeLessThan(0.02);
    const knee1 = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(knee1.distanceTo(knee0)).toBeGreaterThan(0.01);

    // E 模式：箭头收起（球退化为标记）
    ctl.setManipulatorMode('rotate');
    expect(arrows.visible).toBe(false);
    ctl.dispose();
  });

  it('pole 双通道·径向拖 = 弯度：外拽手收回膝弯出（朝向不变），推回轴心腿伸直', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
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
    dom.fire('pointerdown', clientFor(camera, ball0));
    expect(legH.pole.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, center0.clone().addScaledVector(outDir, 0.15)));
    converge();
    expect(legH.target.getWorldPosition(new Vector3()).distanceTo(hip)).toBeCloseTo(2 * Math.sqrt(0.16 - 0.0225), 3);
    const midBent = knee();
    expect(midBent.z).toBeLessThan(-0.08);                // 弯出到 pole 侧
    expect(Math.abs(midBent.x - 0.1)).toBeLessThan(0.03); // 不甩向：仍在原弯面内
    // 球贴着膝（弯度仪表）：TwoBone 是解析解，实测半径即用户意图
    expect(legH.pole.ball.getWorldPosition(new Vector3()).distanceTo(midBent)).toBeLessThan(0.05);

    // 推回轴心（瞄准冻结环心 = 径向直线零点）：手伸到全可达 0.8，腿伸直（膝回链轴）
    dom.fire('pointermove', clientFor(camera, center0));
    dom.fire('pointerup', {});
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
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
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
    // 默认 move：环隐藏且不可命中，球可拖
    expect(hipsH.rings!.visible).toBe(false);
    expect(legH.rings!.visible).toBe(false);
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(legH.target.isDragging).toBe(true);
    dom.fire('pointerup', {});
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true); // pole 在 move 模式可拖（轨道球，纯位置控制点）
    dom.fire('pointerup', {});
    // 点击位置取对角线方向：环心正上/正侧会落进髋球轴箭头的命中区（箭头优先于环的断言对象）
    dom.fire('pointerdown', clientFor(camera, hipsH.rings!.getWorldPosition(new Vector3()).add(new Vector3(0.08, 0.08, 0.08))));
    expect(hipsH.rings!.isDragging).toBe(false);

    // rotate：双通道控制点的球退化成可点标记（不藏、不可拖）；端骨环走主选中、肘环走子选中；
    // pole 球退化为可点标记（上面 move 模式最后拖的是 pole 球，选中 = 'leg:elbow'，故肘环在场、端骨环不上）
    ctl.setManipulatorMode('rotate');
    expect(hipsH.rings!.visible).toBe(false); // 未选中：环不上场
    expect(legH.target.ball.visible).toBe(true); // 球变标记，不藏
    expect(legH.pole.visible).toBe(true); // pole 球变标记，不藏（E 模式选中肘部的入口）
    expect(legH.elbowRings.visible).toBe(true); // 肘部已选中：肘环在场
    expect(legH.rings!.visible).toBe(false); // 端骨环走主选中：选肘部不上场
    // 标记点击 = 选中，不进入拖拽
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(legH.target.isDragging).toBe(false);
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerup', {});
    // 换选肘部子目标：肘环上场、端骨环收起
    ctl.select('leg:elbow');
    expect(legH.elbowRings.visible).toBe(true);
    expect(legH.rings!.visible).toBe(false);
    // 换选别的控制点：旧环收起、新环上场
    ctl.select('hips');
    expect(legH.rings!.visible).toBe(false);
    expect(legH.elbowRings.visible).toBe(false);
    expect(hipsH.rings!.visible).toBe(true);
    // 选中后拖环照常（命中点取有效半径：ringRadius × 屏幕恒定大小缩放）
    const hipsRingR = ringR(hipsH.rings!);
    dom.fire('pointerdown', clientFor(camera, hipsH.rings!.getWorldPosition(new Vector3()).add(new Vector3(0, hipsRingR, 0))));
    expect(hipsH.rings!.isDragging).toBe(true);
    dom.fire('pointerup', {});
    // pole 在 rotate 模式是标记：可见可点不可拖；肘环选中后上场可拖（bend 环 ⊥ 弯折轴 ≈+x，取环上 +y 点）
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(false);
    dom.fire('pointerup', {});
    ctl.select('leg:elbow'); // 肘环走子选中体系：上面已换选 hips，拖前选中肘部
    const kneePos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, kneePos.clone().add(new Vector3(0, ringR(legH.elbowRings), 0))));
    expect(legH.elbowRings.isDragging).toBe(true);
    dom.fire('pointerup', {});
    // 纯位置控制点（chain）两种模式都可用
    dom.fire('pointerdown', clientFor(camera, ctl.get<ChainControlHandle>('spine')!.target.getWorldPosition(new Vector3())));
    expect(ctl.get<ChainControlHandle>('spine')!.target.isDragging).toBe(true);
    dom.fire('pointerup', {});

    ctl.setManipulatorMode('move');
    expect(hipsH.rings!.visible).toBe(false);
    expect(legH.target.ball.visible).toBe(true);
    ctl.dispose();
  });

  it('点空白失焦：原地松开才取消选中；按下后拖动（转视角）不失焦', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
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
    expect(legH.pole.isDragging).toBe(true);
    dom.fire('pointerup', {});

    // 未选中状态点 pole：选中肘部子目标，pole 本身照常可拖
    dom.fire('pointerdown', blank);
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe(null);
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg:elbow'); // 点肘球选中肘部（不影响手臂本体）
    expect(legH.pole.isDragging).toBe(true); // pole 本身照常可拖
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
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true },
      ],
    });
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const foot = rig.getBoneAt(rig.boneIndex('FootL'));
    const before = foot.getWorldQuaternion(new Quaternion());
    // 真指针拖环：rotate 模式 + 选中后绕世界 Y 转 90°
    ctl.setManipulatorMode('rotate');
    ctl.select('leg'); // 环只在选中后上场（Maya 同款：只显示选中的操纵器）
    scene.updateMatrixWorld(true);
    const center = legH.rings!.getWorldPosition(new Vector3());
    const legRingR = ringR(legH.rings!); // 命中点取有效半径
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(legRingR, 0, 0))));
    expect(legH.rings!.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, center.clone().add(new Vector3(0, 0, -legRingR))));
    dom.fire('pointerup', {});
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
      rig, scene, camera, dom,
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
      rig, scene, camera, dom,
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
    const hipsRingR2 = ringR(hipsH.rings!); // 命中点取有效半径
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(hipsRingR2, 0, 0))));
    dom.fire('pointermove', clientFor(camera, center.clone().add(new Vector3(0, 0, -hipsRingR2))));
    dom.fire('pointerup', {});
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
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [{ kind: 'bone', name: 'chest', bone: 'Spine' }],
    });
    const chestH = ctl.get<BoneControlHandle>('chest')!;
    const spine = rig.getBoneAt(rig.boneIndex('Spine'));
    const neck = rig.getBoneAt(rig.boneIndex('Neck'));
    expect(chestH.kind).toBe('bone');
    expect(ctl.targets.length).toBe(1); // 没有位置球，但有一颗常驻标记球（选中入口）

    // move 模式（默认）：环隐藏、不可命中；标记球常驻两种模式
    expect(chestH.rings.visible).toBe(false);
    expect(chestH.marker.ball.visible).toBe(true);
    const neckBefore = neck.getWorldPosition(new Vector3());
    scene.updateMatrixWorld(true);
    const center = chestH.rings.getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(0.08, 0, 0))));
    expect(chestH.rings.isDragging).toBe(false);

    // rotate 模式：环仍要选中后才上场——点标记球选中（标记不可拖，按下即选中）
    ctl.setManipulatorMode('rotate');
    expect(chestH.rings.visible).toBe(false);
    dom.fire('pointerdown', clientFor(camera, chestH.marker.getWorldPosition(new Vector3())));
    expect(chestH.marker.isDragging).toBe(false);
    expect(ctl.getSelected()).toBe('chest');
    expect(chestH.rings.visible).toBe(true);
    dom.fire('pointerup', {});
    // 拖 X 环绕世界 X 转（Spine 正上方是 Neck，绕 Y 转原地打转看不出位移，绕 X 转 Neck 才被带起来）；
    // 取 30°→120° 非基向弧点（基向点同时落在两环平面上，浮点定胜负）；半径取有效半径
    const chestRingR = ringR(chestH.rings);
    const arc = (deg: number) => center.clone().add(
      new Vector3(0, chestRingR * Math.cos(deg * Math.PI / 180), chestRingR * Math.sin(deg * Math.PI / 180)));
    dom.fire('pointerdown', clientFor(camera, arc(30)));
    expect(chestH.rings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, arc(120)));
    dom.fire('pointerup', {});
    const spinePosBefore = spine.getWorldPosition(new Vector3());
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    expect(spine.getWorldQuaternion(new Quaternion()).angleTo(chestH.rings.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-4);
    expect(neck.getWorldPosition(new Vector3()).distanceTo(neckBefore)).toBeGreaterThan(0.1); // 子骨明显被带动
    expect(spine.getWorldPosition(new Vector3()).distanceTo(spinePosBefore)).toBeLessThan(1e-6); // 只拷旋转不碰位置
    ctl.dispose();
  });
});
