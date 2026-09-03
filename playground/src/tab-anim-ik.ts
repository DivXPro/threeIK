import * as THREE from 'three';
import GUI from 'lil-gui';
import { FabrikModifier } from 'threeik';
import { loadSoldier, type LoadedCharacter } from './character';
import { DragTarget } from './drag-target';
import { measureChain } from './chain-utils';
import type { TabHandle, PlaygroundContext } from './main';

export function createAnimIkTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let targets: DragTarget[] = [];
  let unsubFrame: (() => void) | null = null;

  return {
    async mount() {
      character = await loadSoldier(ctx.scene);
      character.actions.get('Idle')!.play();
      const rig = character.rig;

      // FABRIK 右手链 target：初始钉在固定世界点，可拖拽；钳制在右臂可达半径内（模型已转正，右臂在 -X 侧）
      const handTarget = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.55, 1.4, 0.3), 0x33ff77, ctx.dragControl);
      targets = [handTarget];
      ctx.scene.add(handTarget);
      const armChain = measureChain(character.root, 'mixamorigRightArm', 'mixamorigRightHand');
      if (armChain) handTarget.setReachConstraint(armChain.rootBone, armChain.reach);

      // angularDeltaLimit=π：base 每帧被动画重播种，2° 默认值会让手追不上偏离 base 太远的 target
      const fabrik = new FabrikModifier(
        [{ rootBone: 'mixamorigRightArm', endBone: 'mixamorigRightHand', target: handTarget }],
        { maxIterations: 10, angularDeltaLimit: Math.PI },
      );
      rig.addModifier(fabrik);

      // 暂停动画 = 停 mixer.update 且停 captureBasePose：base 停留在最后捕获帧，
      // rig.update 继续合成「最后 base + IK」——演示 base/IK 分层隔离而非姿势漂移。
      const params = { animPlaying: true };
      const ch = character;
      const frameCb = (dt: number) => {
        if (params.animPlaying) {
          ch.mixer.update(dt);
          rig.captureBasePose();
        }
        rig.update(dt);
      };
      unsubFrame = ctx.onFrame(frameCb);

      gui = new GUI({ title: '动画 + IK 叠加' });
      gui.add(params, 'animPlaying').name('播放动画');
      const f = gui.addFolder('FABRIK 右臂');
      f.add(fabrik, 'active').name('启用');
      f.add(fabrik, 'influence', 0, 1, 0.01).name('influence');
      f.add(fabrik, 'maxIterations', 1, 30, 1).name('迭代次数');
      f.add(fabrik, 'angularDeltaLimit', 0, Math.PI, 0.005).name('角度钳制(rad)');
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
