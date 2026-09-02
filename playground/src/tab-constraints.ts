import * as THREE from 'three';
import GUI from 'lil-gui';
import {
  AimModifier,
  CopyTransformModifier,
  CCDIkModifier,
  type AimConfig,
  type CopyTransformConfig,
} from 'threeik';
import { loadSoldier, type LoadedCharacter } from './character';
import { DragTarget } from './drag-target';
import { measureChain } from './chain-utils';
import type { TabHandle, PlaygroundContext } from './main';

export function createConstraintsTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let targets: DragTarget[] = [];
  let unsubFrame: (() => void) | null = null;

  return {
    async mount() {
      character = await loadSoldier(ctx.scene);
      const rig = character.rig;

      // Aim 目标球：未拖拽时自动绕圈，拖拽时由用户控制
      const aimTarget = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0, 1.6, 1.0), 0xff5533);
      // CCD 左手 target：把左手拉开，为 CopyTransform 制造左右手差异
      const leftHandTarget = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.7, 1.3, 0.3), 0x3388ff);
      targets = [aimTarget, leftHandTarget];
      for (const t of targets) ctx.scene.add(t);

      // 左手球钳制在左臂可达半径内（Aim 目标球是方向语义，不钳）
      const armChain = measureChain(character.root, 'mixamorigLeftArm', 'mixamorigLeftHand');
      if (armChain) leftHandTarget.setReachConstraint(armChain.rootBone, armChain.reach);

      const aimConfig: AimConfig = {
        applyBone: 'mixamorigHead',
        referenceType: 'object',
        referenceObject: aimTarget,
        axis: '+y',
        amount: 1,
      };
      const copyConfig: CopyTransformConfig = {
        applyBone: 'mixamorigRightHand',
        referenceType: 'bone',
        referenceBone: 'mixamorigLeftHand',
        copyRotation: true,
        amount: 1,
      };
      const aim = new AimModifier([aimConfig]);
      const copy = new CopyTransformModifier([copyConfig]);
      const ccd = new CCDIkModifier([{ rootBone: 'mixamorigLeftArm', endBone: 'mixamorigLeftHand', target: leftHandTarget }], { maxIterations: 10 });
      // 顺序约束：copy 读取左手全局姿势，须在 ccd 之后执行才能看到本帧 IK 结果
      rig.addModifier(aim);
      rig.addModifier(ccd);
      rig.addModifier(copy);

      let t = 0;
      const center = new THREE.Vector3(0, 1.5, 0.9);
      const frameCb = (dt: number) => {
        t += dt;
        if (!aimTarget.isDragging) {
          aimTarget.position.set(
            center.x + Math.cos(t * 1.2) * 0.7,
            center.y + Math.sin(t * 1.7) * 0.3,
            center.z + Math.sin(t * 1.2) * 0.3,
          );
        }
        rig.update(dt);
      };
      unsubFrame = ctx.onFrame(frameCb);

      gui = new GUI({ title: '约束' });
      const fAim = gui.addFolder('Aim 头部注视');
      fAim.add(aim, 'active').name('启用');
      fAim.add(aim, 'influence', 0, 1, 0.01).name('influence');
      fAim.add(aimConfig, 'amount', 0, 1, 0.01).name('amount');
      const fCopy = gui.addFolder('CopyTransform 右手←左手');
      fCopy.add(copy, 'active').name('启用');
      fCopy.add(copy, 'influence', 0, 1, 0.01).name('influence');
      fCopy.add(copyConfig, 'amount', 0, 1, 0.01).name('amount');
      const fCcd = gui.addFolder('CCD 左臂（制造差异）');
      fCcd.add(ccd, 'active').name('启用');
      fCcd.add(ccd, 'influence', 0, 1, 0.01).name('influence');
      fCcd.add(ccd, 'maxIterations', 1, 30, 1).name('迭代次数');
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
