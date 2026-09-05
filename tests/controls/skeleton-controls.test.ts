import { describe, it, expect } from 'vitest';
import { Bone, MathUtils, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { createSkeletonControls, registerControlKind } from '../../src/controls';
import type { BuiltControl, ControlHandleBase, LimbControlHandle, RootControlHandle } from '../../src/controls';
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
    ]);
    ctl.dispose();
  });

  it('方向型球恒距贴身：pole/注视球与锚骨距离恒为半径', () => {
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
    expect(arm.pole.getWorldPosition(new Vector3()).distanceTo(fore.getWorldPosition(new Vector3()))).toBeCloseTo(0.2, 5);
    expect(ctl.get('head')!.target.getWorldPosition(new Vector3()).distanceTo(neck.getWorldPosition(new Vector3()))).toBeCloseTo(0.35, 5);
    ctl.dispose();
  });

  it('位置球收拢进可达域：初始位置超界被钳到 keepAlive 球面上', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        // 手球摆到距肩 0.9（链长 0.6，keepAlive 0.96 → 钳到 0.576）
        { kind: 'limb', name: 'arm', rootBone: 'ArmL', middleBone: 'ForeL', endBone: 'HandL', position: [0.25 + 0.9, 1.45, 0] },
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
    const hips = ctl.get('hips')!;
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

    ctl.get('hips')!.target.moveTo(new Vector3(0, 0.8, 0)); // 下蹲 0.2
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
        { kind: 'limb', name: 'legNoRoll', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', poleDirection: 'none', pole: { guide: false } },
      ],
    });
    const readCfg = (name: string) =>
      (ctl.get(name)!.modifier as unknown as { configs: { poleDirection?: string; poleDirectionVector?: Vector3 }[] }).configs[0]!;
    expect(readCfg('leg').poleDirection).toBe('custom');
    expect(readCfg('leg').poleDirectionVector!.length()).toBeGreaterThan(0.5);
    expect(readCfg('legNoRoll').poleDirection).toBeUndefined();
    ctl.dispose();
  });

  it('pole 玛雅化·move 模式：拖肘球只调肘朝向（Maya pole vector 语义）——端球不动、弯度不变、膝绕轴转向 pole', () => {
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
    const targetBefore = legH.target.position.clone();
    const midBefore = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const midLive = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());

    // 真指针拖 pole 球到 +x 侧（锥内：与锥轴 (0,0,-1) 夹角 ~76° < 100°）
    dom.fire('pointerdown', clientFor(camera, legH.pole.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true);
    legH.pole.moveTo(midLive.clone().add(new Vector3(0.2, 0, -0.05)));
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    // Maya 语义：pole 只管朝向——端球（弯度的唯一来源）纹丝不动，膝绕链轴摆到 +x 侧
    expect(legH.target.position.distanceTo(targetBefore)).toBeLessThan(1e-6);
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(midBefore.x + 0.02);
    dom.fire('pointerup', {});
    ctl.dispose();
  });

  it('pole 玛雅化·rotate 模式：pole 球隐藏，拖肘部 swivel 环绕链轴转（端球不动）', () => {
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
    const midBefore = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const targetBefore = legH.target.position.clone();

    ctl.setManipulatorMode('rotate');
    expect(legH.pole.ball.visible).toBe(false);
    expect(legH.poleRings.visible).toBe(true);

    // pole 球在 rotate 模式不可拖
    dom.fire('pointerdown', clientFor(camera, legH.pole.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(false);

    // 拖 swivel 环的 X 环：按下点取 X 圆 30°（避开两环交点——那里两环得分同为零，浮点定胜负），
    // 拖到 120°：绕 +X 转 +90°；映射为绕链轴（≈-Y）swivel：pole 从 -z 侧转到 +x 侧
    const R = legH.poleRings.ringRadius;
    const polePos = legH.pole.getWorldPosition(new Vector3());
    const ringPoint = (deg: number) => polePos.clone().add(
      new Vector3(0, R * Math.cos(MathUtils.degToRad(deg)), R * Math.sin(MathUtils.degToRad(deg))));
    dom.fire('pointerdown', clientFor(camera, ringPoint(30)));
    expect(legH.poleRings.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, ringPoint(120)));
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    expect(legH.target.position.distanceTo(targetBefore)).toBeLessThan(1e-6); // swivel 不动端球
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(midBefore.x + 0.02); // 膝随 pole 转到 +x 一侧
    dom.fire('pointerup', {});
    expect(legH.poleRings.isDragging).toBe(false);
    ctl.dispose();
  });

  it('pole 玛雅化·move 模式：肘球带轴箭头，拖 X 箭头单轴调位置（与其他节点一致的移动操纵器）', () => {
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
    const polePos = legH.pole.getWorldPosition(new Vector3());

    // 点 X 箭头中段（箭头长 = 6×球半径 = 0.135，命中区 [0.034, 0.155]）
    dom.fire('pointerdown', clientFor(camera, polePos.clone().add(new Vector3(0.09, 0, 0))));
    expect(legH.pole.isDragging).toBe(true);
    // 斜向拖（含屏幕垂直分量）：轴拖只写 X；y 经锥钳制后仍精确不变证明走的是轴路径而非自由拖
    dom.fire('pointermove', clientFor(camera, polePos.clone().add(new Vector3(0.19, 0.05, 0))));
    expect(legH.pole.position.x).toBeGreaterThan(polePos.x + 0.05);
    expect(legH.pole.position.y).toBeCloseTo(polePos.y, 6);
    dom.fire('pointerup', {});
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

  it('操纵器模式：双通道控制点球↔环切换（pole 也球↔环），纯位置控制点不参战', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'root', name: 'hips', bone: 'Hips', rotation: true },
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, pole: { guide: false } },
        { kind: 'chain', name: 'spine', rootBone: 'Spine', endBone: 'Neck' }, // 纯位置：不参战
      ],
    });
    const hipsH = ctl.get<RootControlHandle>('hips')!;
    const legH = ctl.get<LimbControlHandle>('leg')!;
    expect(hipsH.rings).toBeDefined();
    expect(legH.rings).toBeDefined();
    // 默认 move：环（含 pole swivel 环）隐藏且不可命中，球可拖
    expect(hipsH.rings!.visible).toBe(false);
    expect(legH.rings!.visible).toBe(false);
    expect(legH.poleRings.visible).toBe(false);
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(legH.target.isDragging).toBe(true);
    dom.fire('pointerup', {});
    dom.fire('pointerdown', clientFor(camera, legH.pole.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true); // pole 在 move 模式是普通移动操纵器
    dom.fire('pointerup', {});
    // 点击位置取对角线方向：环心正上/正侧会落进髋球轴箭头的命中区（箭头优先于环的断言对象）
    dom.fire('pointerdown', clientFor(camera, hipsH.rings!.getWorldPosition(new Vector3()).add(new Vector3(0.08, 0.08, 0.08))));
    expect(hipsH.rings!.isDragging).toBe(false);

    // rotate：球藏、环上（pole 球也藏，换 pole swivel 环上场）
    ctl.setManipulatorMode('rotate');
    expect(hipsH.rings!.visible).toBe(true);
    expect(legH.target.ball.visible).toBe(false);
    expect(legH.pole.ball.visible).toBe(false);
    expect(legH.poleRings.visible).toBe(true);
    dom.fire('pointerdown', clientFor(camera, hipsH.target.getWorldPosition(new Vector3())));
    expect(hipsH.target.isDragging).toBe(false);
    dom.fire('pointerdown', clientFor(camera, hipsH.rings!.getWorldPosition(new Vector3()).add(new Vector3(0, 0.08, 0))));
    expect(hipsH.rings!.isDragging).toBe(true);
    dom.fire('pointerup', {});
    // pole swivel 环在 rotate 模式可拖
    dom.fire('pointerdown', clientFor(camera, legH.poleRings.getWorldPosition(new Vector3()).add(new Vector3(0, 0.08, 0))));
    expect(legH.poleRings.isDragging).toBe(true);
    dom.fire('pointerup', {});
    // 纯位置控制点（chain）两种模式都可用
    dom.fire('pointerdown', clientFor(camera, ctl.get('spine')!.target.getWorldPosition(new Vector3())));
    expect(ctl.get('spine')!.target.isDragging).toBe(true);
    dom.fire('pointerup', {});

    ctl.setManipulatorMode('move');
    expect(hipsH.rings!.visible).toBe(false);
    expect(legH.target.ball.visible).toBe(true);
    ctl.dispose();
  });

  it('旋转通道：拖环写 rings 朝向，CopyTransform 把端骨全局旋转对齐过去（①脚朝向）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, pole: { guide: false } },
      ],
    });
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const foot = rig.getBoneAt(rig.boneIndex('FootL'));
    const before = foot.getWorldQuaternion(new Quaternion());
    // 真指针拖环：rotate 模式下绕世界 Y 转 90°
    ctl.setManipulatorMode('rotate');
    scene.updateMatrixWorld(true);
    const center = legH.rings!.getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(0.08, 0, 0))));
    expect(legH.rings!.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, center.clone().add(new Vector3(0, 0, -0.08))));
    dom.fire('pointerup', {});
    rig.update(0); // CopyTransform 求解：端骨对齐 rings 朝向
    ctl.update();
    scene.updateMatrixWorld(true);
    const after = foot.getWorldQuaternion(new Quaternion());
    expect(after.angleTo(before)).toBeGreaterThan(0.5); // 明显转动（~90°）
    expect(after.angleTo(legH.rings!.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-4);
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
    dom.fire('pointermove', clientFor(camera, center.clone().add(new Vector3(0, 0, -0.08))));
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
});
