import * as THREE from 'three';
import GUI from 'lil-gui';
import { CCDIkModifier, FabrikModifier, TwoBoneIkModifier, type SkeletonRig } from 'threeik';
import { loadSoldier, type LoadedCharacter } from './character';
import { DragTarget } from './drag-target';
import { measureChain } from './chain-utils';
import { RootMotionModifier } from './root-motion';
import type { TabHandle, PlaygroundContext } from './main';

export function createIkTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let targets: DragTarget[] = [];
  let unsubFrame: (() => void) | null = null;
  let poleGuides: { line: THREE.Line; pole: DragTarget; joint: THREE.Object3D }[] = [];
  let guideMat: THREE.LineBasicMaterial | null = null;
  let hipsAnchor: THREE.Object3D | null = null;

  return {
    async mount() {
      character = await loadSoldier(ctx.scene);
      const rig = character.rig;
      // 调试：控制台可直读 rig/modifier 状态（page 重载后失效，随 mount 重建）
      Object.assign((window as unknown as { __threeik: Record<string, unknown> }).__threeik, { rig });

      // 可拖拽 target：髋（重心）、双手、双脚、脊柱（弯腰）、头部（注视）；双膝双肘各一个 pole
      const hips = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0, 1.06, 0), 0xff3399, ctx.dragControl);
      const leftHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.55, 1.4, 0.25), 0xff5533, ctx.dragControl);
      const rightHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.55, 1.4, 0.25), 0x33ff77, ctx.dragControl);
      const leftFoot = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.3, 0.4), 0x3388ff, ctx.dragControl);
      const rightFoot = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.25, 0.3, 0.4), 0x22dddd, ctx.dragControl);
      const spine = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0, 1.25, 0.3), 0xcc66ff, ctx.dragControl);
      const head = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0, 1.7, 0.9), 0xffffff, ctx.dragControl);
      const leftKneePole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.9, 1.2), 0xffcc00, ctx.dragControl);
      const rightKneePole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.25, 0.9, 1.2), 0xff9933, ctx.dragControl);
      const leftElbowPole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.45, 1.3, 0.8), 0xccff66, ctx.dragControl);
      const rightElbowPole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.45, 1.3, 0.8), 0x66ffcc, ctx.dragControl);
      targets = [hips, leftHand, rightHand, leftFoot, rightFoot, spine, head, leftKneePole, rightKneePole, leftElbowPole, rightElbowPole];
      for (const t of targets) ctx.scene.add(t);

      // pole → 关节引导线：pole 只控制关节绕链轴的朝向（不移动末端），拉线让作用关系可见
      const guideMatLocal = new THREE.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.45, depthTest: false });
      guideMat = guideMatLocal;
      poleGuides = ([
        [leftKneePole, 'mixamorigLeftLeg'], [rightKneePole, 'mixamorigRightLeg'],
        [leftElbowPole, 'mixamorigLeftForeArm'], [rightElbowPole, 'mixamorigRightForeArm'],
      ] as const)
        .map(([pole, jointName]) => {
          const joint = character!.root.getObjectByName(jointName)!;
          const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
          const line = new THREE.Line(geo, guideMatLocal);
          line.renderOrder = 998;
          line.frustumCulled = false;
          ctx.scene.add(line);
          return { line, pole, joint };
        });

      // 手臂恰好是双骨链（Arm→ForeArm→Hand），换 TwoBone 以支持肘 pole（CCD/FABRIK 无 pole 概念，
      // 仍分别由头部/脊柱演示）。angularDeltaLimit=π（等效关闭，同 Godot 官方 IK demo）：update 每帧
      // 从 base 姿势重新播种（等价 Godot deterministic 模式），2°/迭代默认值会把每帧关节转角预算
      // 卡死在 20°——离 rest 远的 target 永远到不了
      const armL = new TwoBoneIkModifier([{
        rootBone: 'mixamorigLeftArm', middleBone: 'mixamorigLeftForeArm', endBone: 'mixamorigLeftHand',
        target: leftHand, poleTarget: leftElbowPole,
      }]);
      const armR = new TwoBoneIkModifier([{
        rootBone: 'mixamorigRightArm', middleBone: 'mixamorigRightForeArm', endBone: 'mixamorigRightHand',
        target: rightHand, poleTarget: rightElbowPole,
      }]);
      const legL = new TwoBoneIkModifier([{
        rootBone: 'mixamorigLeftUpLeg', middleBone: 'mixamorigLeftLeg', endBone: 'mixamorigLeftFoot',
        target: leftFoot, poleTarget: leftKneePole,
      }]);
      const legR = new TwoBoneIkModifier([{
        rootBone: 'mixamorigRightUpLeg', middleBone: 'mixamorigRightLeg', endBone: 'mixamorigRightFoot',
        target: rightFoot, poleTarget: rightKneePole,
      }]);
      // 脊柱 FABRIK 拉躯干（Spine→Neck），头部 CCD（Neck→Head）在其结果上叠加注视——共享 Neck，故 head 须排在 spine 之后
      const spineMod = new FabrikModifier([{ rootBone: 'mixamorigSpine', endBone: 'mixamorigNeck', target: spine }], { maxIterations: 10, angularDeltaLimit: Math.PI });
      const headMod = new CCDIkModifier([{ rootBone: 'mixamorigNeck', endBone: 'mixamorigHead', target: head }], { maxIterations: 10, angularDeltaLimit: Math.PI });
      // 髋部根骨位移（重心/下蹲）
      const hipsMod = new RootMotionModifier('mixamorigHips', hips);
      // 顺序约束：hips 搬动全身（腿根/脊柱根），必须最先；spine 会移动肩膀（手臂链根的父链），
      // 必须先于手臂求解，否则手臂按旧肩位解完又被搬走；head 在 spine 之后叠加注视（共享 Neck）
      rig.addModifier(hipsMod);
      rig.addModifier(legL);
      rig.addModifier(legR);
      rig.addModifier(spineMod);
      rig.addModifier(armL);
      rig.addModifier(armR);
      rig.addModifier(headMod);

      // 位置型 target 硬钳制在链可达半径内
      const reachEntries: { target: DragTarget; rootBone: THREE.Object3D; reach: number }[] = [];
      for (const [target, rootName, endName] of [
        [leftHand, 'mixamorigLeftArm', 'mixamorigLeftHand'],
        [rightHand, 'mixamorigRightArm', 'mixamorigRightHand'],
        [leftFoot, 'mixamorigLeftUpLeg', 'mixamorigLeftFoot'],
        [rightFoot, 'mixamorigRightUpLeg', 'mixamorigRightFoot'],
        [spine, 'mixamorigSpine', 'mixamorigNeck'],
      ] as const) {
        const m = measureChain(character.root, rootName, endName);
        if (m) reachEntries.push({ target, rootBone: m.rootBone, reach: m.reach });
      }

      // 方向型 target（头部注视/pole）做方向锥钳制：锥轴 = 角色朝向（模型局部前方 -Z，
      // 经 root 转到世界），防止拖到脑后（头反拧）或关节后方（膝/肘反折）；距离收拢只是防止球飘走
      const facing = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(character.root.getWorldQuaternion(new THREE.Quaternion()));
      const neckBone = character.root.getObjectByName('mixamorigNeck')!;
      const leftKneeBone = character.root.getObjectByName('mixamorigLeftLeg')!;
      const rightKneeBone = character.root.getObjectByName('mixamorigRightLeg')!;
      const leftElbowBone = character.root.getObjectByName('mixamorigLeftForeArm')!;
      const rightElbowBone = character.root.getObjectByName('mixamorigRightForeArm')!;

      // 髋部球钳制在以 rest 髋位为球心的固定球域内（重心移动范围；锚点是静态参照物，不随骨骼动）
      const hipsAnchorObj = new THREE.Object3D();
      hipsAnchorObj.position.copy(character.root.getObjectByName('mixamorigHips')!.getWorldPosition(new THREE.Vector3()));
      hipsAnchor = hipsAnchorObj;
      ctx.scene.add(hipsAnchorObj);

      // 钳制参数（GUI 可调；setter 自带收拢，改完立即生效）。
      // 头/pole = 半径球（贴身，防飘远）+ 方向锥（只管角度，防反拧/反折）双重钳制
      const clampParams = {
        reachScale: 1,
        hipsRadius: 0.4,
        headRadius: 0.6, headAngleDeg: 105,
        poleRadius: 0.5, poleAngleDeg: 100,
      };
      const applyReach = () => {
        for (const e of reachEntries) e.target.setReachConstraint(e.rootBone, e.reach * clampParams.reachScale);
      };
      const applyHips = () => hips.setReachConstraint(hipsAnchorObj, clampParams.hipsRadius);
      const applyHeadCone = () => {
        head.setReachConstraint(neckBone, clampParams.headRadius);
        head.setConeConstraint(neckBone, facing, THREE.MathUtils.degToRad(clampParams.headAngleDeg), 0, Infinity);
      };
      const applyPoleCone = () => {
        for (const [pole, joint] of [
          [leftKneePole, leftKneeBone], [rightKneePole, rightKneeBone],
          [leftElbowPole, leftElbowBone], [rightElbowPole, rightElbowBone],
        ] as const) {
          pole.setReachConstraint(joint, clampParams.poleRadius);
          pole.setConeConstraint(joint, facing, THREE.MathUtils.degToRad(clampParams.poleAngleDeg), 0, Infinity);
        }
      };
      applyReach();
      applyHips();
      applyHeadCone();
      applyPoleCone();

      // 球随锚点携带：拖其他部位带动锚点（脊柱弯腰搬肩、髋球搬膝肘）时球保持相对偏移跟随，
      // 不滞留在原地脱离钳制域。脚刻意不携带——钉地是下蹲演示的基础（锚点 UpLeg 随髋动），
      // 动画+IK 页同理不携带（手钉世界固定点正是该页的演示语义）
      for (const e of reachEntries) {
        if (e.target === leftFoot || e.target === rightFoot) continue;
        e.target.setCarry(e.rootBone);
      }
      head.setCarry(neckBone);
      leftKneePole.setCarry(leftKneeBone);
      rightKneePole.setCarry(rightKneeBone);
      leftElbowPole.setCarry(leftElbowBone);
      rightElbowPole.setCarry(rightElbowBone);

      const _gp = new THREE.Vector3();
      const _gk = new THREE.Vector3();
      const frameCb = () => {
        rig.update(1 / 60); // 无动画路径：base = rest，直接 update
        for (const t of targets) t.carryAlong(); // 求解后锚点世界位置已更新，非拖拽球跟随
        for (const g of poleGuides) {
          g.pole.getWorldPosition(_gp);
          g.joint.getWorldPosition(_gk); // rig.update 已写回骨骼 TRS，getWorldPosition 现算链路
          const pos = g.line.geometry.getAttribute('position') as THREE.BufferAttribute;
          pos.setXYZ(0, _gk.x, _gk.y, _gk.z);
          pos.setXYZ(1, _gp.x, _gp.y, _gp.z);
          pos.needsUpdate = true;
        }
      };
      unsubFrame = ctx.onFrame(frameCb);

      gui = new GUI({ title: 'IK' });
      for (const [name, mod] of [
        ['髋部 RootMotion', hipsMod],
        ['TwoBone 左腿', legL], ['TwoBone 右腿', legR],
        ['FABRIK 脊柱', spineMod],
        ['TwoBone 左臂', armL], ['TwoBone 右臂', armR],
        ['CCD 头部注视', headMod],
      ] as const) {
        const f = gui.addFolder(name);
        f.add(mod, 'active').name('启用');
        f.add(mod, 'influence', 0, 1, 0.01).name('influence');
        if ('maxIterations' in mod) {
          f.add(mod as CCDIkModifier, 'maxIterations', 1, 30, 1).name('迭代次数');
          f.add((mod as CCDIkModifier), 'angularDeltaLimit', 0, Math.PI, 0.005).name('求解角步长(rad)');
        }
      }
      // 球的范围钳制参数（区别于求解器的"求解角步长"）
      const fClamp = gui.addFolder('钳制（拖球范围）');
      fClamp.add(clampParams, 'reachScale', 0.3, 1.5, 0.01).name('位置球半径倍率').onChange(applyReach);
      fClamp.add(clampParams, 'hipsRadius', 0.1, 0.8, 0.01).name('髋部活动半径(m)').onChange(applyHips);
      const reachInfo = {
        臂: reachEntries[0] ? +reachEntries[0].reach.toFixed(3) : 0,
        腿: reachEntries[2] ? +reachEntries[2].reach.toFixed(3) : 0,
        脊柱: reachEntries[4] ? +reachEntries[4].reach.toFixed(3) : 0,
      };
      fClamp.add(reachInfo, '臂').name('臂链长(m,实测)').disable();
      fClamp.add(reachInfo, '腿').name('腿链长(m,实测)').disable();
      fClamp.add(reachInfo, '脊柱').name('脊柱链长(m,实测)').disable();
      const fHead = fClamp.addFolder('头部注视球');
      fHead.add(clampParams, 'headRadius', 0.2, 1.5, 0.05).name('半径(m)').onChange(applyHeadCone);
      fHead.add(clampParams, 'headAngleDeg', 30, 170, 1).name('半角(°)').onChange(applyHeadCone);
      const fPole = fClamp.addFolder('膝/肘 pole 球');
      fPole.add(clampParams, 'poleRadius', 0.15, 1, 0.05).name('半径(m)').onChange(applyPoleCone);
      fPole.add(clampParams, 'poleAngleDeg', 30, 170, 1).name('半角(°)').onChange(applyPoleCone);
      gui.add({ reset: () => rig.resetToRest() }, 'reset').name('重置 rest pose');
    },
    unmount() {
      gui?.destroy();
      gui = null;
      unsubFrame?.();
      unsubFrame = null;
      if (hipsAnchor) ctx.scene.remove(hipsAnchor);
      hipsAnchor = null;
      if (character) {
        ctx.scene.remove(character.root);
        ctx.scene.remove(character.helper);
      }
      for (const g of poleGuides) {
        ctx.scene.remove(g.line);
        g.line.geometry.dispose();
      }
      guideMat?.dispose();
      guideMat = null;
      poleGuides = [];
      for (const t of targets) {
        ctx.scene.remove(t);
        t.dispose();
      }
      targets = [];
      character = null;
    },
  };
}
