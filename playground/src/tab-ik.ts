import * as THREE from 'three';
import GUI from 'lil-gui';
import { CCDIkModifier, FabrikModifier, TwoBoneIkModifier, type SkeletonRig } from 'threeik';
import { loadSoldier, type LoadedCharacter } from './character';
import { DragTarget } from './drag-target';
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

      // 三个可拖拽 target：左手、右手、左脚（外加左腿 pole）
      const leftHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.7, 1.3, 0.3), 0xff5533);
      const rightHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.7, 1.3, 0.3), 0x33ff77);
      const leftFoot = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.3, 0.4), 0x3388ff);
      const leftKneePole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.9, 1.2), 0xffcc00);
      targets = [leftHand, rightHand, leftFoot, leftKneePole];
      for (const t of targets) ctx.scene.add(t);

      const ccd = new CCDIkModifier([{ rootBone: 'mixamorigLeftArm', endBone: 'mixamorigLeftHand', target: leftHand }], { maxIterations: 10 });
      const fabrik = new FabrikModifier([{ rootBone: 'mixamorigRightArm', endBone: 'mixamorigRightHand', target: rightHand }], { maxIterations: 10 });
      const leg = new TwoBoneIkModifier([{
        rootBone: 'mixamorigLeftUpLeg', middleBone: 'mixamorigLeftLeg', endBone: 'mixamorigLeftFoot',
        target: leftFoot, poleTarget: leftKneePole,
      }]);
      rig.addModifier(ccd);
      rig.addModifier(fabrik);
      rig.addModifier(leg);

      const frameCb = () => { rig.update(1 / 60); }; // 无动画路径：base = rest，直接 update
      unsubFrame = ctx.onFrame(frameCb);

      gui = new GUI({ title: 'IK' });
      for (const [name, mod] of [['CCD 左臂', ccd], ['FABRIK 右臂', fabrik], ['TwoBone 左腿', leg]] as const) {
        const f = gui.addFolder(name);
        f.add(mod, 'active').name('启用');
        f.add(mod, 'influence', 0, 1, 0.01).name('influence');
        if ('maxIterations' in mod) {
          f.add(mod as CCDIkModifier, 'maxIterations', 1, 30, 1).name('迭代次数');
          f.add((mod as CCDIkModifier), 'angularDeltaLimit', 0, 0.35, 0.005).name('角度钳制(rad)');
        }
      }
      gui.add({ reset: () => rig.resetToRest() }, 'reset').name('重置 rest pose');
    },
    unmount() {
      gui?.destroy();
      gui = null;
      unsubFrame?.();
      unsubFrame = null;
      if (character) ctx.scene.remove(character.root);
      for (const t of targets) {
        ctx.scene.remove(t);
        t.dispose();
      }
      targets = [];
      character = null;
    },
  };
}
