import * as THREE from 'three';
import GUI from 'lil-gui';
import { CCDIkModifier, FabrikModifier, TwoBoneIkModifier, type SkeletonRig } from 'threeik';
import { loadSoldier, type LoadedCharacter } from './character';
import { DragTarget } from './drag-target';
import { measureChain } from './chain-utils';
import type { TabHandle, PlaygroundContext } from './main';

export function createIkTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let targets: DragTarget[] = [];
  let unsubFrame: (() => void) | null = null;

  return {
    async mount() {
      character = await loadSoldier(ctx.scene);
      const rig = character.rig;
      // 调试：控制台可直读 rig/modifier 状态（page 重载后失效，随 mount 重建）
      Object.assign((window as unknown as { __threeik: Record<string, unknown> }).__threeik, { rig });

      // 可拖拽 target：双手、双脚、脊柱（弯腰）、头部（注视）；双膝各一个 pole
      const leftHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.55, 1.4, 0.25), 0xff5533, ctx.dragControl);
      const rightHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.55, 1.4, 0.25), 0x33ff77, ctx.dragControl);
      const leftFoot = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.3, 0.4), 0x3388ff, ctx.dragControl);
      const rightFoot = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.25, 0.3, 0.4), 0x22dddd, ctx.dragControl);
      const spine = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0, 1.25, 0.3), 0xcc66ff, ctx.dragControl);
      const head = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0, 1.7, 0.9), 0xffffff, ctx.dragControl);
      const leftKneePole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.9, 1.2), 0xffcc00, ctx.dragControl);
      const rightKneePole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.25, 0.9, 1.2), 0xff9933, ctx.dragControl);
      targets = [leftHand, rightHand, leftFoot, rightFoot, spine, head, leftKneePole, rightKneePole];
      for (const t of targets) ctx.scene.add(t);

      // pole → 膝盖引导线：pole 只控制膝盖绕「髋→踝」轴的朝向（不移动脚），拉线让作用关系可见
      const guideMat = new THREE.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.45, depthTest: false });
      const poleGuides = ([[leftKneePole, 'mixamorigLeftLeg'], [rightKneePole, 'mixamorigRightLeg']] as const)
        .map(([pole, kneeName]) => {
          const knee = character!.root.getObjectByName(kneeName)!;
          const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
          const line = new THREE.Line(geo, guideMat);
          line.renderOrder = 998;
          line.frustumCulled = false;
          ctx.scene.add(line);
          return { line, pole, knee };
        });

      // angularDeltaLimit=π（等效关闭，同 Godot 官方 IK demo）：我们的 update 每帧从 base 姿势重新播种
      // （等价 Godot deterministic 模式），保留默认 2°/迭代会把每帧关节转角预算卡死在 20°——
      // 从 T-pose 指向体前目标需要肩部转 90°+ 且不跨帧累积，手会永远停在半路
      const ccd = new CCDIkModifier([{ rootBone: 'mixamorigLeftArm', endBone: 'mixamorigLeftHand', target: leftHand }], { maxIterations: 10, angularDeltaLimit: Math.PI });
      const fabrik = new FabrikModifier([{ rootBone: 'mixamorigRightArm', endBone: 'mixamorigRightHand', target: rightHand }], { maxIterations: 10, angularDeltaLimit: Math.PI });
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
      // 顺序约束：spine 会移动肩膀（手臂链根的父链），必须先于手臂求解，否则手臂按 rest 肩位解完、
      // spine 再把肩搬走，手永远差一个肩部位移量；head 在 spine 之后叠加注视（共享 Neck）
      rig.addModifier(legL);
      rig.addModifier(legR);
      rig.addModifier(spineMod);
      rig.addModifier(ccd);
      rig.addModifier(fabrik);
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

      // 方向型 target（头部注视/膝盖 pole）做方向锥钳制：锥轴 = 角色朝向（模型局部前方 -Z，
      // 经 root 转到世界），防止拖到脑后（头反拧）或腿后（膝盖反折）；距离收拢只是防止球飘走
      const facing = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(character.root.getWorldQuaternion(new THREE.Quaternion()));
      const neckBone = character.root.getObjectByName('mixamorigNeck')!;
      const leftKneeBone = character.root.getObjectByName('mixamorigLeftLeg')!;
      const rightKneeBone = character.root.getObjectByName('mixamorigRightLeg')!;

      // 钳制参数（GUI 可调；setter 自带收拢，改完立即生效）。
      // 头/pole = 半径球（贴身，防飘远）+ 方向锥（只管角度，防反拧/反折）双重钳制
      const clampParams = {
        reachScale: 1,
        headRadius: 0.6, headAngleDeg: 105,
        poleRadius: 0.5, poleAngleDeg: 100,
      };
      const applyReach = () => {
        for (const e of reachEntries) e.target.setReachConstraint(e.rootBone, e.reach * clampParams.reachScale);
      };
      const applyHeadCone = () => {
        head.setReachConstraint(neckBone, clampParams.headRadius);
        head.setConeConstraint(neckBone, facing, THREE.MathUtils.degToRad(clampParams.headAngleDeg), 0, Infinity);
      };
      const applyPoleCone = () => {
        for (const [pole, knee] of [[leftKneePole, leftKneeBone], [rightKneePole, rightKneeBone]] as const) {
          pole.setReachConstraint(knee, clampParams.poleRadius);
          pole.setConeConstraint(knee, facing, THREE.MathUtils.degToRad(clampParams.poleAngleDeg), 0, Infinity);
        }
      };
      applyReach();
      applyHeadCone();
      applyPoleCone();

      const _gp = new THREE.Vector3();
      const _gk = new THREE.Vector3();
      const frameCb = () => {
        rig.update(1 / 60); // 无动画路径：base = rest，直接 update
        for (const g of poleGuides) {
          g.pole.getWorldPosition(_gp);
          g.knee.getWorldPosition(_gk); // rig.update 已写回骨骼 TRS，getWorldPosition 现算链路
          const pos = g.line.geometry.getAttribute('position') as THREE.BufferAttribute;
          pos.setXYZ(0, _gk.x, _gk.y, _gk.z);
          pos.setXYZ(1, _gp.x, _gp.y, _gp.z);
          pos.needsUpdate = true;
        }
      };
      unsubFrame = ctx.onFrame(frameCb);

      gui = new GUI({ title: 'IK' });
      for (const [name, mod] of [
        ['CCD 左臂', ccd], ['FABRIK 右臂', fabrik],
        ['TwoBone 左腿', legL], ['TwoBone 右腿', legR],
        ['FABRIK 脊柱', spineMod], ['CCD 头部注视', headMod],
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
      const fPole = fClamp.addFolder('膝盖 pole 球');
      fPole.add(clampParams, 'poleRadius', 0.15, 1, 0.05).name('半径(m)').onChange(applyPoleCone);
      fPole.add(clampParams, 'poleAngleDeg', 30, 170, 1).name('半角(°)').onChange(applyPoleCone);
      gui.add({ reset: () => rig.resetToRest() }, 'reset').name('重置 rest pose');
    },
    unmount() {
      gui?.destroy();
      gui = null;
      unsubFrame?.();
      unsubFrame = null;
      if (character) {
        ctx.scene.remove(character.root);
        ctx.scene.remove(character.helper);
      }
      for (const g of poleGuides) {
        ctx.scene.remove(g.line);
        g.line.geometry.dispose();
      }
      guideMat.dispose();
      for (const t of targets) {
        ctx.scene.remove(t);
        t.dispose();
      }
      targets = [];
      character = null;
    },
  };
}
