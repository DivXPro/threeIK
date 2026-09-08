import * as THREE from 'three';
import GUI from 'lil-gui';
import type { CCDIkModifier } from 'threeik';
import {
  createSkeletonControls,
  type BoneControlHandle,
  type ChainControlHandle,
  type LimbControlHandle,
  type LookAtControlHandle,
  type RootControlHandle,
  type SkeletonControls,
} from 'threeik/controls';
import { loadCharacter, type LoadedCharacter } from './character';
import type { TabHandle, PlaygroundContext } from './main';

export function createIkTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let ctl: SkeletonControls | null = null;
  let unsubFrame: (() => void) | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  return {
    async mount() {
      character = await loadCharacter(ctx.scene);
      const rig = character.rig;
      // 调试：控制台可直读 rig/控制点句柄（page 重载后失效，随 mount 重建）
      Object.assign((window as unknown as { __threeik: Record<string, unknown> }).__threeik, { rig });

      // 角色朝向（由加载器按模型局部前方实测）：方向锥轴/pole 自动摆位的参照
      const facing = character.facing;

      // 声明式装配：hips(重心) → 双腿(脚钉地 carry:false) → spine(弯腰) → 胸口/脖子(直接掰骨)
      // → 双臂(肩=大臂旋转环、肘 pole 朝后) → head(注视)。声明顺序即同深度 tiebreak（腿先于脊柱）；深度排序由装配器完成。
      // 初始化保持 T 姿势：位置球不设 position（缺省 = 端骨 rest 世界位置，零位移）；keepAlive 默认 1
      // （完全伸直）：pole 球恒 ⊥ 链轴，roll 修正把肘/膝方向带过退化点，四肢能真正伸直到 rest
      ctl = createSkeletonControls({
        rig,
        scene: ctx.scene,
        camera: ctx.camera,
        dom: ctx.renderer.domElement,
        dragControl: ctx.dragControl,
        facing,
        controls: [
          { kind: 'root', name: 'hips', bone: 'mixamorigHips', color: 0xff3399, position: [0, 1.06, 0], rotation: true, ringRadius: 0.24 },
          {
            kind: 'limb', name: 'legL',
            rootBone: 'mixamorigLeftUpLeg', middleBone: 'mixamorigLeftLeg', endBone: 'mixamorigLeftFoot',
            color: 0x3388ff,
            carry: false, // 脚钉地：下蹲演示的基础（锚点 UpLeg 随髋动）
            endRotation: true, // ①脚朝向：rotate 模式下脚部旋转环
            rootRotation: true, // 髋部 = 髋关节掰大腿（扭转+摆动，脚跟随）
            pole: { color: 0xffcc00, position: [0.25, 0.9, 1.2] },
          },
          {
            kind: 'limb', name: 'legR',
            rootBone: 'mixamorigRightUpLeg', middleBone: 'mixamorigRightLeg', endBone: 'mixamorigRightFoot',
            color: 0x22dddd,
            carry: false,
            endRotation: true,
            rootRotation: true,
            pole: { color: 0xff9933, position: [-0.25, 0.9, 1.2] },
          },
          // 脊柱 FABRIK 拉躯干（Spine→Neck）
          { kind: 'chain', name: 'spine', rootBone: 'mixamorigSpine', endBone: 'mixamorigNeck', color: 0xcc66ff },
          // 直接掰骨（纯旋转：点标记球选中即出环，不看 W/E）：胸口拧上半身/侧倾、脖子摆头。
          // 深度排序：胸口环在脊柱 FABRIK 之后生效（弯腰之上再拧）；脖子环声明在头部注视之前
          // （同深度按声明顺序）：CCD 随后把头重新瞄准注视球——摆脖子不会丢注视
          { kind: 'bone', name: 'chest', bone: 'mixamorigSpine2', color: 0xff99cc, ringRadius: 0.28 },
          { kind: 'bone', name: 'neck', bone: 'mixamorigNeck', color: 0xdddd99 },
          {
            kind: 'limb', name: 'armL',
            rootBone: 'mixamorigLeftArm', middleBone: 'mixamorigLeftForeArm', endBone: 'mixamorigLeftHand',
            color: 0xff5533,
            endRotation: true, // 手腕翻向
            rootRotation: true, // 肩部 = 肩关节掰大臂（扭转+摆动，手跟随）——不掰锁骨，那不符合人体构造
            // 肘 pole：球以定长绕「肩→腕」链轴转（轨道球），初始方向提示摆肘的后下方（世界 -Z = 身后，≈自然垂臂的弯曲方向）
            pole: { color: 0xccff66, position: [0.38, 0.98, -0.2] },
          },
          {
            kind: 'limb', name: 'armR',
            rootBone: 'mixamorigRightArm', middleBone: 'mixamorigRightForeArm', endBone: 'mixamorigRightHand',
            color: 0x33ff77,
            endRotation: true,
            rootRotation: true,
            pole: { color: 0x66ffcc, position: [-0.38, 0.98, -0.2] },
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
      const bones = ['chest', 'neck']
        .map((n) => ctl!.get<BoneControlHandle>(n)!);
      const limbs = [legLH, legRH, armLH, armRH];

      // 钳制参数。四肢伸展上限（poleKeepAlive）：默认 1 = 完全伸直（pole 球恒 ⊥ 链轴，roll 修正
      // 把肘/膝方向带过退化点——实测弯→伸→弯稳定）；滑到 <1 可体验「永远留弯度」的旧行为
      // （注意 0.96 会在手臂这种短骨链上摆出 15°+ 上臂摆角，看起来像耸肩缩脖）
      const clampParams = {
        reachScale: 1,
        poleKeepAlive: 1,
        hipsRadius: 0.4,
        headRadius: 0.35, headAngleDeg: 105,
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
      const params = { manipulatorMode: 'move' as 'move' | 'rotate' };

      // 操纵器模式（Maya W/E）：W = 移动球 + 肘/膝 pole 球（双通道影子球）；E = 旋转环。
      // 纯旋转控制点（胸口/脖子/肩/髋）两种模式都选中即出环——W/E 只对双通道控制点（髋/脚/手/肘）有意义
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
        else if (e.key === 'Escape') ctl!.select(null); // 取消选中：操纵器（箭头/环）收起
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
      // 直接掰骨（胸口/脖子）：旋转专用控制点，选中即出环（不看 W/E）
      const fBone = gui.addFolder('直接掰骨');
      for (const [i, name] of ['胸口', '脖子'].entries()) {
        fBone.add(bones[i]!.modifier, 'active').name(name);
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
