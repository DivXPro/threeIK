import GUI from 'lil-gui';
import { RetargetModifier } from '@dreamerbird/threeik';
import { loadCharacter, type LoadedCharacter } from './character';
import { buildMannequin } from './mannequin';
import type { TabHandle, PlaygroundContext } from './main';

export function createRetargetTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let mannequin: ReturnType<typeof buildMannequin> | null = null;
  let retarget: RetargetModifier | null = null;
  let unsubFrame: (() => void) | null = null;

  return {
    async mount() {
      character = await loadCharacter(ctx.scene);
      character.actions.get('walk')!.play();

      mannequin = buildMannequin(1.4);
      mannequin.root.position.set(1.2, 0, 0);
      ctx.scene.add(mannequin.root);
      ctx.scene.add(mannequin.helper);

      character.rig.motionScale = character.rig.computeMotionScaleFromBone('mixamorigHips');
      mannequin.rig.motionScale = mannequin.rig.computeMotionScaleFromBone('Hips');

      retarget = new RetargetModifier({ source: character.rig, sourceBoneMap: character.boneMap });
      mannequin.rig.addModifier(retarget);

      // useGlobalPose 是 RetargetModifier 的 private readonly：开关 = 重建 modifier
      // （removeModifier → 新实例 → addModifier，attach 自动重建缓存）。
      // influence 经 params 每帧套用，切换实例后绑定不失效。
      const params = { useGlobalPose: false, influence: 1 };
      const ch = character;
      const mq = mannequin;
      const frameCb = (dt: number) => {
        ch.mixer.update(dt);
        ch.rig.captureBasePose();
        ch.rig.update(dt);
        if (retarget) retarget.influence = params.influence;
        mq.rig.update(dt); // 目标后更新（RetargetModifier 契约：源先更新）
      };
      unsubFrame = ctx.onFrame(frameCb);

      gui = new GUI({ title: '重定向' });
      gui.add(params, 'useGlobalPose').name('useGlobalPose').onChange((v: boolean) => {
        if (retarget) mq.rig.removeModifier(retarget);
        retarget = new RetargetModifier({ source: ch.rig, sourceBoneMap: ch.boneMap, useGlobalPose: v });
        mq.rig.addModifier(retarget);
      });
      gui.add(params, 'influence', 0, 1, 0.01).name('influence');
      gui.add({ reset: () => { ch.rig.resetToRest(); mq.rig.resetToRest(); } }, 'reset').name('重置 rest pose');
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
      if (mannequin) {
        ctx.scene.remove(mannequin.root);
        ctx.scene.remove(mannequin.helper);
      }
      character = null;
      mannequin = null;
      retarget = null;
    },
  };
}
