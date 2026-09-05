import * as THREE from 'three';
import GUI from 'lil-gui';
import type { CCDIkModifier } from 'threeik';
import {
  createSkeletonControls,
  type ChainControlHandle,
  type LimbControlHandle,
  type LookAtControlHandle,
  type RootControlHandle,
  type SkeletonControls,
} from 'threeik/controls';
import { loadSoldier, type LoadedCharacter } from './character';
import type { TabHandle, PlaygroundContext } from './main';

export function createIkTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let ctl: SkeletonControls | null = null;
  let unsubFrame: (() => void) | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  return {
    async mount() {
      character = await loadSoldier(ctx.scene);
      const rig = character.rig;
      // 调试：控制台可直读 rig/控制点句柄（page 重载后失效，随 mount 重建）
      Object.assign((window as unknown as { __threeik: Record<string, unknown> }).__threeik, { rig });

      // 角色朝向（模型局部前方 -Z 经 root 旋转到世界）：方向锥轴/pole 自动摆位的参照
      const facing = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(character.root.getWorldQuaternion(new THREE.Quaternion()));

      // 声明式装配：hips(重心) → 双腿(脚钉地 carry:false) → spine(弯腰) → 双臂(肘 pole 朝后) → head(注视)。
      // 声明顺序即同深度 tiebreak（腿先于脊柱）；深度排序由装配器完成（hips 最先、head 最后）。
      // 手球初始位置须在臂可达范围内部（距肩 ~70% 链长）：贴在球面上手臂完全伸直时
      // 肘落在肩→腕轴上，pole 绕轴旋转在几何上是零效应，肘 pole 会"拖了没反应"
      ctl = createSkeletonControls({
        rig,
        scene: ctx.scene,
        camera: ctx.camera,
        dom: ctx.renderer.domElement,
        dragControl: ctx.dragControl,
        facing,
        controls: [
          { kind: 'root', name: 'hips', bone: 'mixamorigHips', color: 0xff3399, position: [0, 1.06, 0], rotation: true, ringRadius: 0.12 },
          {
            kind: 'limb', name: 'legL',
            rootBone: 'mixamorigLeftUpLeg', middleBone: 'mixamorigLeftLeg', endBone: 'mixamorigLeftFoot',
            color: 0x3388ff, position: [0.25, 0.3, 0.4],
            carry: false, // 脚钉地：下蹲演示的基础（锚点 UpLeg 随髋动）
            endRotation: true, // ①脚朝向：rotate 模式下脚部旋转环
            pole: { color: 0xffcc00, position: [0.25, 0.9, 1.2] },
          },
          {
            kind: 'limb', name: 'legR',
            rootBone: 'mixamorigRightUpLeg', middleBone: 'mixamorigRightLeg', endBone: 'mixamorigRightFoot',
            color: 0x22dddd, position: [-0.25, 0.3, 0.4],
            carry: false,
            endRotation: true,
            pole: { color: 0xff9933, position: [-0.25, 0.9, 1.2] },
          },
          // 脊柱 FABRIK 拉躯干（Spine→Neck）
          { kind: 'chain', name: 'spine', rootBone: 'mixamorigSpine', endBone: 'mixamorigNeck', color: 0xcc66ff, position: [0, 1.25, 0.3] },
          {
            kind: 'limb', name: 'armL',
            rootBone: 'mixamorigLeftArm', middleBone: 'mixamorigLeftForeArm', endBone: 'mixamorigLeftHand',
            color: 0xff5533, position: [0.35, 1.33, 0.32],
            endRotation: true, // 手腕翻向
            // 肘 pole 默认在肘的下方偏后（≈肘朝下，自然垂臂的弯曲方向）：锥轴取背后方向，
            // 半角 130° 覆盖垂臂姿势（膝的 100° 会把这些自然姿势挡在锥外）
            pole: { color: 0xccff66, position: [0.38, 0.98, 0.2], coneAxis: 'backward', coneAngleDeg: 130 },
          },
          {
            kind: 'limb', name: 'armR',
            rootBone: 'mixamorigRightArm', middleBone: 'mixamorigRightForeArm', endBone: 'mixamorigRightHand',
            color: 0x33ff77, position: [-0.35, 1.33, 0.32],
            endRotation: true,
            pole: { color: 0x66ffcc, position: [-0.38, 0.98, 0.2], coneAxis: 'backward', coneAngleDeg: 130 },
          },
          // 头部 CCD（Neck→Head）在脊柱结果上叠加注视——深度排序保证 head 排在 spine 之后
          { kind: 'lookAt', name: 'head', rootBone: 'mixamorigNeck', endBone: 'mixamorigHead', color: 0xffffff, position: [0, 1.7, 0.9] },
        ],
      });
      Object.assign((window as unknown as { __threeik: Record<string, unknown> }).__threeik, { ctl });

      const frameCb = () => {
        rig.update(1 / 60); // 无动画路径：base = rest，直接 update
        ctl!.update();      // 求解后：携带 → 环跟随 → 引导线
      };
      unsubFrame = ctx.onFrame(frameCb);

      // ---- GUI：钳制/求解参数全部走控制点句柄，setter 立即生效 ----
      const hipsH = ctl.get<RootControlHandle>('hips')!;
      const legLH = ctl.get<LimbControlHandle>('legL')!;
      const legRH = ctl.get<LimbControlHandle>('legR')!;
      const armLH = ctl.get<LimbControlHandle>('armL')!;
      const armRH = ctl.get<LimbControlHandle>('armR')!;
      const spineH = ctl.get<ChainControlHandle>('spine')!;
      const headH = ctl.get<LookAtControlHandle>('head')!;
      const limbs = [legLH, legRH, armLH, armRH];

      // 钳制参数。四肢伸展上限（poleKeepAlive）：完全伸直时肘/膝的可行解集从「两球交线圆」
      // 退化成相切点，pole 失去选择自由——几何固有，非实现缺陷。96% 处仍留 ~6cm 回旋空间，
      // pole 永远活着，肉眼读作"伸直"；滑到 1.0 可亲手体验退化点
      const clampParams = {
        reachScale: 1,
        poleKeepAlive: 0.96,
        hipsRadius: 0.4,
        headRadius: 0.35, headAngleDeg: 105,
        poleRadius: 0.2, poleAngleDeg: 100, elbowPoleAngleDeg: 130,
      };
      const applyReach = () => {
        for (const l of limbs) {
          l.setReachScale(clampParams.reachScale);
          l.setKeepAlive(clampParams.poleKeepAlive);
        }
        spineH.setReachScale(clampParams.reachScale); // 脊柱无 pole，不吃 keepAlive
      };
      const applyHips = () => hipsH.setRadius(clampParams.hipsRadius);
      const applyHeadCone = () => {
        headH.setRadius(clampParams.headRadius);
        headH.setConeAngleDeg(clampParams.headAngleDeg);
      };
      const applyPoleCone = () => {
        for (const l of [legLH, legRH]) {
          l.setPoleRadius(clampParams.poleRadius);
          l.setPoleConeAngleDeg(clampParams.poleAngleDeg);
        }
        for (const l of [armLH, armRH]) {
          l.setPoleRadius(clampParams.poleRadius);
          l.setPoleConeAngleDeg(clampParams.elbowPoleAngleDeg);
        }
      };
      const params = { manipulatorMode: 'move' as 'move' | 'rotate' };

      // 操纵器模式（Maya W/E）：W = 移动球，E = 旋转环（双通道控制点：髋/脚/手/肘/膝）
      let modeCtrl: { updateDisplay(): void } | null = null;
      const applyMode = (m: 'move' | 'rotate') => {
        params.manipulatorMode = m;
        ctl!.setManipulatorMode(m);
        modeCtrl?.updateDisplay(); // 键盘切换后 GUI 下拉框同步
      };
      const onKeyHandler = (e: KeyboardEvent) => {
        if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
        if (e.key === 'w' || e.key === 'W') applyMode('move');
        else if (e.key === 'e' || e.key === 'E') applyMode('rotate');
      };
      onKey = onKeyHandler;
      window.addEventListener('keydown', onKeyHandler);

      gui = new GUI({ title: 'IK' });
      modeCtrl = gui.add(params, 'manipulatorMode', { '移动 (W)': 'move', '旋转 (E)': 'rotate' })
        .name('操纵器模式')
        .onChange((v: 'move' | 'rotate') => applyMode(v));
      for (const [name, mod] of [
        ['髋部 RootMotion', hipsH.modifier],
        ['TwoBone 左腿', legLH.modifier], ['TwoBone 右腿', legRH.modifier],
        ['FABRIK 脊柱', spineH.modifier],
        ['TwoBone 左臂', armLH.modifier], ['TwoBone 右臂', armRH.modifier],
        ['CCD 头部注视', headH.modifier],
      ] as const) {
        const f = gui.addFolder(name);
        f.add(mod, 'active').name('启用');
        f.add(mod, 'influence', 0, 1, 0.01).name('influence');
        if ('maxIterations' in mod) {
          f.add(mod as CCDIkModifier, 'maxIterations', 1, 30, 1).name('迭代次数');
          f.add(mod as CCDIkModifier, 'angularDeltaLimit', 0, Math.PI, 0.005).name('求解角步长(rad)');
        }
      }
      // 球的范围钳制参数（区别于求解器的"求解角步长"）
      const fClamp = gui.addFolder('钳制（拖球范围）');
      fClamp.add(clampParams, 'reachScale', 0.3, 1.5, 0.01).name('位置球半径倍率').onChange(applyReach);
      fClamp.add(clampParams, 'poleKeepAlive', 0.85, 1, 0.005).name('四肢伸展上限(pole保活)').onChange(applyReach);
      fClamp.add(clampParams, 'hipsRadius', 0.1, 0.8, 0.01).name('髋部活动半径(m)').onChange(applyHips);
      const reachInfo = {
        臂: +armLH.reach.toFixed(3),
        腿: +legLH.reach.toFixed(3),
        脊柱: +spineH.reach.toFixed(3),
      };
      fClamp.add(reachInfo, '臂').name('臂链长(m,实测)').disable();
      fClamp.add(reachInfo, '腿').name('腿链长(m,实测)').disable();
      fClamp.add(reachInfo, '脊柱').name('脊柱链长(m,实测)').disable();
      const fHead = fClamp.addFolder('头部注视球');
      // 半径下限 0.3：CCD 端骨（Head 原点）离颈 ~0.12m，球太近会进入可达域，
      // 求解从"纯注视瞄准"退化成"摆放端骨"，头会拧去够球
      fHead.add(clampParams, 'headRadius', 0.3, 1, 0.05).name('半径(m)').onChange(applyHeadCone);
      fHead.add(clampParams, 'headAngleDeg', 30, 170, 1).name('半角(°)').onChange(applyHeadCone);
      const fPole = fClamp.addFolder('膝/肘 pole 球');
      fPole.add(clampParams, 'poleRadius', 0.1, 0.8, 0.05).name('半径(m)').onChange(applyPoleCone);
      fPole.add(clampParams, 'poleAngleDeg', 30, 170, 1).name('膝半角(°)').onChange(applyPoleCone);
      fPole.add(clampParams, 'elbowPoleAngleDeg', 30, 170, 1).name('肘半角(°)').onChange(applyPoleCone);
      gui.add({ reset: () => rig.resetToRest() }, 'reset').name('重置 rest pose');
    },
    unmount() {
      if (onKey) window.removeEventListener('keydown', onKey);
      onKey = null;
      gui?.destroy();
      gui = null;
      unsubFrame?.();
      unsubFrame = null;
      ctl?.dispose(); // 球/引导线/髋锚点/modifier 统一清场
      ctl = null;
      if (character) {
        ctx.scene.remove(character.root);
        ctx.scene.remove(character.helper);
      }
      character = null;
    },
  };
}
