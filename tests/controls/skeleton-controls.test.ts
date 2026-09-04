import { describe, it, expect } from 'vitest';
import { Bone, MathUtils, Object3D, Scene, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { createSkeletonControls, registerControlKind } from '../../src/controls';
import type { BuiltControl, ControlHandleBase, LimbControlHandle } from '../../src/controls';
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

  // 舵控几何常数（迷你腿链 a=b=0.4）：pole 初始在 mid + facing(0,0,-1)×0.2 = (0.1,0.6,-0.2)，
  // 离轴 h0=0.2；chainSpan(h) = 2·√(0.16−h²)。Δ 映射：h肘 = 锁存时肘高 + (h球 − h球0)，d = span(h肘)
  const span = (h: number) => 2 * Math.sqrt(0.16 - h * h);

  it('steer 舵控：拉直时拖 pole 离轴弯臂、拖回线上伸直（可逆）；关闭则不响应', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, steer: true },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    legH.setKeepAlive(1);
    legH.target.moveTo(new Vector3(0.1, 0.2, 0)); // 拉直到全伸展（链长 0.8，恰为 rest 脚位）
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    const rootPos = rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());

    // 真指针按下 pole 球（舵控以 isDragging 为门）
    dom.fire('pointerdown', clientFor(camera, legH.pole.getWorldPosition(new Vector3())));
    expect(legH.pole.isDragging).toBe(true);
    rig.update(0);
    ctl.update(); // 进入舵控：记录零点（h肘0=0 全直，h球0=0.2），球离面

    // 拖离轴：pole +0.2x → (0.3,0.6,-0.2)，h球=√0.08；h肘 = 0 + √0.08 − 0.2 ≈ 0.0828，d = span(h肘)
    const distBefore = legH.target.position.distanceTo(rootPos);
    legH.pole.moveTo(legH.pole.position.clone().add(new Vector3(0.2, 0, 0)));
    rig.update(0);
    ctl.update();
    const dBent = span(Math.sqrt(0.08) - 0.2);
    expect(distBefore).toBeCloseTo(0.8, 4); // 锁存时全直
    expect(legH.target.position.distanceTo(rootPos)).toBeCloseTo(dBent, 4);
    expect(legH.target.position.distanceTo(rootPos)).toBeLessThan(0.8); // 弯了

    // 弯向下中骨倒向 pole 一侧（+x）：steer 在 ctl.update 改写端球，骨骼要等下一帧求解
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    const midPos = rig.getBoneAt(rig.boneIndex('LegL')).getWorldPosition(new Vector3());
    expect(midPos.x).toBeGreaterThan(0.11);

    // 拖回线上：pole 几乎贴轴（h=0.02828）→ d 超过可达上限被钳回 0.8（伸直，可逆）
    legH.pole.moveTo(new Vector3(0.12, 0.6, -0.02));
    rig.update(0);
    ctl.update();
    expect(legH.target.position.distanceTo(rootPos)).toBeCloseTo(0.8, 5);

    // 关闭舵控：pole 吸回球面，再拖不再转交
    legH.setSteer(false);
    const endBefore = legH.target.position.clone();
    legH.pole.moveTo(legH.pole.position.clone().add(new Vector3(0.1, 0, 0)));
    rig.update(0);
    ctl.update();
    expect(legH.target.position.distanceTo(endBefore)).toBeLessThan(1e-6);
    dom.fire('pointerup', {});
    ctl.dispose();
  });

  it('steer 舵控：绕轴转 pole 时离轴距离不变，端球不动（纯 swivel 不引起弯度变化）', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, steer: true },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    legH.setKeepAlive(1);
    legH.target.moveTo(new Vector3(0.1, 0.2, 0));
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    dom.fire('pointerdown', clientFor(camera, legH.pole.getWorldPosition(new Vector3())));
    rig.update(0);
    ctl.update();

    // 绕轴（x=0.1, z=0 的竖线）从 (0.1,0.6,-0.2) 转到 (0.3,0.6,0)：离轴距离都是 0.2
    const endBefore = legH.target.position.clone();
    legH.pole.moveTo(new Vector3(0.3, 0.6, 0));
    rig.update(0);
    ctl.update();
    expect(legH.target.position.distanceTo(endBefore)).toBeLessThan(1e-6);
    dom.fire('pointerup', {});
    ctl.dispose();
  });

  it('默认 keepAlive 下 steer 可触发：端球顶在钳制边界即视为"拉到最直"', () => {
    const { rig } = buildRig();
    const { scene, camera, dom } = makeCtx(rig);
    const ctl = createSkeletonControls({
      rig, scene, camera, dom,
      controls: [
        { kind: 'limb', name: 'leg', rootBone: 'UpLegL', middleBone: 'LegL', endBone: 'FootL', carry: false, steer: true },
      ],
    });
    scene.updateMatrixWorld(true);
    const legH = ctl.get<LimbControlHandle>('leg')!;
    rig.update(0);
    ctl.update();
    scene.updateMatrixWorld(true);
    const rootPos = rig.getBoneAt(rig.boneIndex('UpLegL')).getWorldPosition(new Vector3());
    const distBefore = legH.target.position.distanceTo(rootPos); // 0.768（钳制边界，= 锁存时的骨距 d0）
    dom.fire('pointerdown', clientFor(camera, legH.pole.getWorldPosition(new Vector3())));
    rig.update(0);
    ctl.update();
    // 首解会把腿往 pole 侧（-z）弯一点，pole 被中骨携带后其实际离轴距离 h0 需现场实测
    const axis = legH.target.position.clone().sub(rootPos).normalize();
    const perp = (p: Vector3) => {
      const off = p.clone().sub(rootPos);
      return Math.sqrt(Math.max(0, off.lengthSq() - off.dot(axis) ** 2));
    };
    const h0 = perp(legH.pole.getWorldPosition(new Vector3()));
    // 拖得更离轴：pole → (0.4,0.6,-0.2)。Δ 映射：h肘 = h肘0 + (h球 − h0)，d = span(h肘)；
    // h肘0 由锁存骨距反推：aProj = d0/2（a=b），h肘0 = √(0.16 − aProj²)；实现侧 h肘 封顶 min(a,b)×0.999
    const hMax = 0.4 * 0.999;
    const hElbow0 = Math.sqrt(Math.max(0, 0.16 - (distBefore / 2) ** 2));
    const hElbowOf = (p: Vector3) => MathUtils.clamp(hElbow0 + perp(p) - h0, 0, hMax);
    legH.pole.moveTo(new Vector3(0.4, 0.6, -0.2));
    rig.update(0);
    ctl.update();
    const dExpect = span(hElbowOf(legH.pole.position));
    expect(legH.target.position.distanceTo(rootPos)).toBeCloseTo(dExpect, 4);
    expect(legH.target.position.distanceTo(rootPos)).toBeLessThan(distBefore); // 确实弯了
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
});
