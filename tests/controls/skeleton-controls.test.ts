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
    expect(arm.pole.ball.getWorldPosition(new Vector3()).distanceTo(fore.getWorldPosition(new Vector3()))).toBeCloseTo(0.2, 5);
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

  it('pole 轨道球·拖球沿环滑调肘朝向——端球不动、弯度不变、膝绕轴转向 pole', () => {
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

    // 真指针拖球沿环到 +x 侧：环心 = 膝(0.1,0.6,0)、环面 ⊥ 链轴(≈-Y) 即水平面、半径 0.2
    const ballPos = legH.pole.ball.getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, ballPos));
    expect(legH.pole.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, new Vector3(0.3, 0.6, 0))); // 环上 +x 点（在环面上，射线命中精确）
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    // Maya 语义：pole 只管朝向——端球（弯度的唯一来源）纹丝不动，膝绕链轴摆到 +x 侧
    expect(legH.target.position.distanceTo(targetBefore)).toBeLessThan(1e-6);
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(midBefore.x + 0.02);
    // 球被吸回环上：与环心（膝）同处环面（y 相等）、距环心恒为半径 0.2
    const ballAfter = legH.pole.ball.getWorldPosition(new Vector3());
    expect(ballAfter.y).toBeCloseTo(midPos.y, 5);
    expect(ballAfter.distanceTo(midPos)).toBeCloseTo(0.2, 5);
    dom.fire('pointerup', {});
    expect(legH.pole.isDragging).toBe(false);
    ctl.dispose();
  });

  it('pole 轨道球·rotate 模式：pole 是纯位置控制点不收起，拖球照常沿环调肘朝向（端球不动）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, keepAlive: 0.96 }, // 留弯度才能测 pole 摆膝
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
    // 端球退化成可点标记（不藏）；端骨环只在选中后上场（未选中）；pole 不参战：球仍显示、可拖
    expect(legH.target.ball.visible).toBe(true);
    expect(legH.rings!.visible).toBe(false);
    expect(legH.pole.ball.visible).toBe(true);

    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true);
    // 与 move 模式同一拖法：球沿环到 +x 侧 → 膝转向 +x，端球（弯度唯一来源）不动
    dom.fire('pointermove', clientFor(camera, new Vector3(0.3, 0.6, 0)));
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    expect(legH.target.position.distanceTo(targetBefore)).toBeLessThan(1e-6);
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(midBefore.x + 0.02);
    dom.fire('pointerup', {});
    expect(legH.pole.isDragging).toBe(false);
    ctl.dispose();
  });

  it('pole 轨道球·离环拖动被吸回环面：球恒在环上（距环心=半径、轴向分量≈0）', () => {
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

    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true);
    // 朝远离环面的方向拖（往地面 +z 远处拽；视线会穿过 y≈0.6 环面，命中点投回环面取方向）
    dom.fire('pointermove', clientFor(camera, new Vector3(0.1, 0, 0.5)));
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);

    const center = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    const ball = legH.pole.ball.getWorldPosition(new Vector3());
    const off = ball.clone().sub(center);
    expect(off.length()).toBeCloseTo(0.2, 5);       // 恒距：球在环上
    expect(off.y).toBeCloseTo(0, 5);                 // 环面 ⊥ 链轴(≈-Y)：轴向分量吸到 0
    expect(off.z).toBeGreaterThan(0.1);              // 方向仍然跟手（拽向 +z 侧，球转去 +z）
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

  it('操纵器模式：双通道控制点球↔环切换，纯位置控制点（含 pole）不参战', () => {
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

    // rotate：双通道控制点的球退化成可点标记（不藏、不可拖）；环只在选中后上场；
    // pole 是纯位置控制点，不收起、照常可拖
    ctl.setManipulatorMode('rotate');
    expect(hipsH.rings!.visible).toBe(false); // 未选中：环不上场
    expect(legH.target.ball.visible).toBe(true); // 球变标记，不藏
    expect(legH.pole.ball.visible).toBe(true);
    // 标记点击 = 选中，不进入拖拽；选中后该控制点的环上场
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(legH.target.isDragging).toBe(false);
    expect(ctl.getSelected()).toBe('leg');
    expect(legH.rings!.visible).toBe(true);
    dom.fire('pointerup', {});
    // 换选别的控制点：旧环收起、新环上场
    ctl.select('hips');
    expect(legH.rings!.visible).toBe(false);
    expect(hipsH.rings!.visible).toBe(true);
    // 选中后拖环照常
    dom.fire('pointerdown', clientFor(camera, hipsH.rings!.getWorldPosition(new Vector3()).add(new Vector3(0, 0.08, 0))));
    expect(hipsH.rings!.isDragging).toBe(true);
    dom.fire('pointerup', {});
    // pole 在 rotate 模式仍可拖（与 chain 等纯位置控制点同待遇）
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true);
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

  it('点空白失焦：pointerdown 无操纵器认领即取消选中；点中操纵器不失焦', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'root', name: 'hips', bone: 'Hips', rotation: true },
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, pole: { guide: false } },
      ],
    });
    const legH = ctl.get<LimbControlHandle>('leg')!;
    const blank = { clientX: 2, clientY: 2, pointerId: 1 }; // 画布角落：射线打不到任何操纵器

    // 点球选中 → 点空白取消
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerup', {});
    dom.fire('pointerdown', blank);
    expect(ctl.getSelected()).toBe(null);
    dom.fire('pointerup', {});

    // 点中操纵器（pole 球）不失焦
    dom.fire('pointerdown', clientFor(camera, legH.pole.ball.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg');
    dom.fire('pointerup', {});

    // 标记点击（rotate 模式）同样算认领：选中后不被自己的 pointerdown 反取消
    ctl.setManipulatorMode('rotate');
    dom.fire('pointerdown', clientFor(camera, legH.target.getWorldPosition(new Vector3())));
    expect(ctl.getSelected()).toBe('leg');
    expect(legH.target.isDragging).toBe(false); // 标记：只选中不拖拽
    dom.fire('pointerup', {});
    // 空白点击在 rotate 模式也失焦
    dom.fire('pointerdown', blank);
    expect(ctl.getSelected()).toBe(null);
    dom.fire('pointerup', {});
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
    // 真指针拖环：rotate 模式 + 选中后绕世界 Y 转 90°
    ctl.setManipulatorMode('rotate');
    ctl.select('leg'); // 环只在选中后上场（Maya 同款：只显示选中的操纵器）
    scene.updateMatrixWorld(true);
    const center = legH.rings!.getWorldPosition(new Vector3());
    dom.fire('pointerdown', clientFor(camera, center.clone().add(new Vector3(0.08, 0, 0))));
    expect(legH.rings!.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, center.clone().add(new Vector3(0, 0, -0.08))));
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
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, endRotation: true, pole: { guide: false } },
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
    // 取 30°→120° 非基向弧点（基向点同时落在两环平面上，浮点定胜负）
    const arc = (deg: number) => center.clone().add(
      new Vector3(0, 0.08 * Math.cos(deg * Math.PI / 180), 0.08 * Math.sin(deg * Math.PI / 180)));
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
