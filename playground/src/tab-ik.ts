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

      // 位置型 target 硬钳制在链可达半径内（pole/头部注视是方向语义，不钳）
      for (const [target, rootName, endName] of [
        [leftHand, 'mixamorigLeftArm', 'mixamorigLeftHand'],
        [rightHand, 'mixamorigRightArm', 'mixamorigRightHand'],
        [leftFoot, 'mixamorigLeftUpLeg', 'mixamorigLeftFoot'],
        [rightFoot, 'mixamorigRightUpLeg', 'mixamorigRightFoot'],
        [spine, 'mixamorigSpine', 'mixamorigNeck'],
      ] as const) {
        const m = measureChain(character.root, rootName, endName);
        if (m) target.setReachConstraint(m.rootBone, m.reach);
      }

      const frameCb = () => { rig.update(1 / 60); }; // 无动画路径：base = rest，直接 update
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
          f.add((mod as CCDIkModifier), 'angularDeltaLimit', 0, Math.PI, 0.005).name('角度钳制(rad)');
        }
      }
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
      for (const t of targets) {
        ctx.scene.remove(t);
        t.dispose();
      }
      targets = [];
      character = null;
    },
  };
}
