import { Camera, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../core/skeleton-rig';
import { ThreeIKError } from '../core/errors';
import { DragTarget, type DragControl, type DragDom, type DragPointerEvent } from './drag-target';
import { resolveCustomControlKind } from './registry';
import { buildRootControl, type RootControlSpec } from './kinds/root';
import { buildLimbControl, type LimbControlSpec } from './kinds/limb';
import { buildLookAtControl, type LookAtControlSpec } from './kinds/look-at';
import { buildChainControl, type ChainControlSpec } from './kinds/chain';
import { buildBoneControl, type BoneControlSpec } from './kinds/bone';
import type { BuiltControl, ControlBuildContext, ControlHandleBase, ControlKindFactory, ControlsDefaults, ControlSpecBase, ManipulatorMode } from './types';

export type BuiltinControlSpec = RootControlSpec | LimbControlSpec | LookAtControlSpec | ChainControlSpec | BoneControlSpec;
/** 声明式控制点：内置 4 种 + registerControlKind 注册的自定义 kind */
export type ControlPointSpec = BuiltinControlSpec | (ControlSpecBase & { kind: string });

export interface SkeletonControlsOptions {
  rig: SkeletonRig;
  /** 控制球/引导线的挂点（世界坐标定位，务必传场景顶层） */
  scene: Object3D;
  camera: Camera;
  /** 指针事件宿主（通常是 renderer.domElement；node 测试传 DragDom 桩） */
  dom: DragDom;
  /** 拖球期间锁定视角控制的计数锁（playground scene.ts 有参考实现） */
  dragControl?: DragControl;
  /** 角色朝向（世界系），默认 (0,0,-1)（three.js 惯例前方 -Z）；模型 root 旋转过请显式传入 */
  facing?: Vector3;
  defaults?: ControlsDefaults;
  controls: ControlPointSpec[];
}

const BUILTINS: Record<string, ControlKindFactory> = {
  root: buildRootControl as ControlKindFactory,
  limb: buildLimbControl as ControlKindFactory,
  lookAt: buildLookAtControl as ControlKindFactory,
  chain: buildChainControl as ControlKindFactory,
  bone: buildBoneControl as ControlKindFactory,
};

/** 空白按下的「点击」位移容差（px²）：超过即视为拖拽（转视角等），不触发失焦 */
const BLUR_CLICK_SLOP_SQ = 4 * 4;

/**
 * 骨架控制点装配器：声明式挂一整套拖球 + modifier，并把三条实测结论固化在流程里——
 *  1. modifier 按根骨在骨架中的深度排序（hips 搬全身最先解；spine 动肩膀必须先于手臂；
 *     同深度保持声明顺序）
 *  2. 装配时内部先跑一帧 rig.update(0)，钳制锚点/携带偏移/poleDirection 都按求解后姿势捕获
 *  3. limb 的 roll 修正实测（poleDirection:'auto'）是声明开关；pole 是 Maya 式 pole vector——
 *     只管肘/膝朝向不管弯度（弯度由端球离根远近决定）；操纵器为轨道球（定长绕链轴转），
 *     纯位置控制点，不参与 W/E 切换
 *
 * 应用侧每帧：`rig.update(dt)` 之后调 `ctl.update()`（携带 → 环跟随 → 引导线）。
 */
export class SkeletonControls {
  private readonly controls = new Map<string, BuiltControl>();
  private readonly ctx: ControlBuildContext;
  private manipulatorMode: ManipulatorMode = 'move';
  private selectedName: string | null = null;
  /** 本轮 pointerdown 有操纵器 onPress 认领（选中/拖拽）；点空白失焦的判定标记 */
  private pressClaimed = false;
  /** 空白处按下的待定失焦：按下记位置，移动超阈值取消（那是在转视角），原地松开才失焦 */
  private pendingBlur: { x: number; y: number } | null = null;
  private readonly dom: DragDom;
  private readonly onDomPointerDown: (e: DragPointerEvent) => void;
  private readonly onDomPointerMove: (e: DragPointerEvent) => void;
  private readonly onDomPointerUp: () => void;

  constructor(options: SkeletonControlsOptions) {
    const { rig } = options;
    this.ctx = {
      rig,
      scene: options.scene,
      camera: options.camera,
      dom: options.dom,
      dragControl: options.dragControl,
      facing: (options.facing ?? new Vector3(0, 0, -1)).clone().normalize(),
      defaults: {
        reachScale: 1, poleKeepAlive: 1,
        lookAtRadius: 0.35, lookAtAngleDeg: 105, rootRadius: 0.4, ballRadius: 0.0225, ringRadius: 0.16,
        ...options.defaults,
      },
      bone: (name) => rig.getBoneAt(rig.boneIndex(name)),
      select: (name) => { this.pressClaimed = true; this.select(name); },
      claim: () => { this.pressClaimed = true; },
    };

    const built = options.controls.map((spec) => this.buildControl(spec));
    // 深度排序后统一 addModifier（sort 稳定，同深度保持声明顺序）
    const mods: { modifier: BuiltControl['modifiers'][number]['modifier']; depth: number }[] = [];
    for (const c of built) {
      for (const m of c.modifiers) mods.push({ modifier: m.modifier, depth: this.boneDepth(m.rootBone) });
    }
    mods.sort((a, b) => a.depth - b.depth);
    for (const m of mods) rig.addModifier(m.modifier);
    // 先求解一帧再设钳制/携带：锚点（肩/肘/颈/膝…）要取求解后的世界位置，
    // 否则携带偏移按 rest 捕获，姿势变化后球被甩飞
    rig.update(0);
    for (const c of built) c.postSolve();

    // 点空白失焦（松开时判定）：pointerdown 监听器在全部操纵器之后注册（同一 dom 按注册
    // 顺序运行），轮到它时本轮事件若无任何操纵器 onPress 认领，即按在空白处——记下待定失焦；
    // 之后拖动超阈值（那是在转视角等）取消待定，原地松开才真正失焦。
    // 三类操纵器（DragTarget/PoleOrbit/RotateRings）命中时都会先调 onPress，无需逐个查拖拽态
    this.dom = options.dom;
    this.onDomPointerDown = (e) => {
      if (this.pressClaimed) { this.pressClaimed = false; this.pendingBlur = null; return; }
      this.pendingBlur = { x: e.clientX, y: e.clientY };
    };
    this.onDomPointerMove = (e) => {
      if (!this.pendingBlur) return;
      const dx = e.clientX - this.pendingBlur.x;
      const dy = e.clientY - this.pendingBlur.y;
      if (dx * dx + dy * dy > BLUR_CLICK_SLOP_SQ) this.pendingBlur = null;
    };
    this.onDomPointerUp = () => {
      if (!this.pendingBlur) return;
      this.pendingBlur = null;
      this.select(null);
    };
    this.dom.addEventListener('pointerdown', this.onDomPointerDown);
    this.dom.addEventListener('pointermove', this.onDomPointerMove);
    this.dom.addEventListener('pointerup', this.onDomPointerUp);
  }

  /** 取参数调节句柄（按声明时的 name）；泛型收窄到具体句柄类型 */
  get<T extends ControlHandleBase = ControlHandleBase>(name: string): T | undefined {
    return this.controls.get(name)?.handle as T | undefined;
  }

  /** 全部拖球（调/测用） */
  get targets(): DragTarget[] {
    return [...this.controls.values()].flatMap((c) => c.targets);
  }

  /** 运行时新增控制点：modifier 追加在管线末尾（不参与全局深度重排，需要严格排序请一次声明全量） */
  add(spec: ControlPointSpec): ControlHandleBase {
    const c = this.buildControl(spec);
    for (const m of c.modifiers) this.ctx.rig.addModifier(m.modifier);
    this.ctx.rig.update(0);
    c.postSolve();
    return c.handle;
  }

  remove(name: string): void {
    const c = this.controls.get(name);
    if (!c) return;
    for (const m of c.modifiers) this.ctx.rig.removeModifier(m.modifier);
    c.dispose();
    this.controls.delete(name);
    if (this.selectedName === name) this.selectedName = null;
  }

  /** 每帧调用（rig.update 之后）：携带跟随 → 环跟随 → 引导线 → 操纵器屏幕恒定大小 */
  update(): void {
    for (const c of this.controls.values()) {
      for (const t of c.targets) t.carryAlong();
      c.update?.();
      for (const t of c.targets) t.updateFrame();
    }
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDomPointerDown);
    this.dom.removeEventListener('pointermove', this.onDomPointerMove);
    this.dom.removeEventListener('pointerup', this.onDomPointerUp);
    this.pendingBlur = null;
    for (const c of this.controls.values()) {
      for (const m of c.modifiers) this.ctx.rig.removeModifier(m.modifier);
      c.dispose();
    }
    this.controls.clear();
  }

  /** 操纵器模式切换（Maya W/E）：move = 位置球，rotate = 旋转环。
   *  双通道控制点的球在 rotate 模式变成可点标记（选中用）；纯位置控制点两种模式下都保持可拖 */
  setManipulatorMode(mode: ManipulatorMode): void {
    if (this.manipulatorMode === mode) return;
    this.manipulatorMode = mode;
    for (const c of this.controls.values()) this.applyView(c);
  }

  getManipulatorMode(): ManipulatorMode {
    return this.manipulatorMode;
  }

  /** 选中控制点（Maya 同款：只有选中的显示操纵器——move 模式显轴箭头、rotate 模式显旋转环）；
   *  传 null 取消选中。操纵器的 onPress 会自动调它（点哪个选中哪个） */
  select(name: string | null): void {
    if (name !== null && !this.controls.has(name)) return;
    if (this.selectedName === name) return;
    this.selectedName = name;
    for (const c of this.controls.values()) this.applyView(c);
  }

  getSelected(): string | null {
    return this.selectedName;
  }

  /** 每个控制点的显隐规则：球/标记 = 控制对象（常显），箭头/环 = 操纵器（仅选中显示） */
  private applyView(c: BuiltControl): void {
    const move = this.manipulatorMode === 'move';
    const selected = this.selectedName === c.name;
    const hasRings = !!c.rotateRings?.length;
    for (const t of c.moveTargets ?? c.targets) {
      t.setVisible(true);
      t.setInteractive(true);
      // rotate 模式下双通道球退化成可点标记（选中入口，不可拖）；纯位置控制点不受模式影响
      t.setMarkerMode(!move && hasRings);
      t.setSelected(move && selected); // 轴箭头：move 模式 + 选中
    }
    for (const r of c.rotateRings ?? []) {
      const show = !move && selected; // 旋转环：rotate 模式 + 选中
      r.setInteractive(show);
      r.setVisible(show);
    }
  }

  private buildControl(spec: ControlPointSpec): BuiltControl {
    if (this.controls.has(spec.name)) {
      throw ThreeIKError.configError(`控制点重名: "${spec.name}"`);
    }
    const factory = resolveCustomControlKind(spec.kind) ?? BUILTINS[spec.kind];
    if (!factory) {
      throw ThreeIKError.configError(`未知控制点 kind: "${spec.kind}"（自定义类型先用 registerControlKind 注册）`);
    }
    const c = factory(this.ctx, spec);
    this.controls.set(spec.name, c);
    this.applyView(c);
    return c;
  }

  /** 骨在骨架中的深度（rig 根骨 = 0）：modifier 排序键，浅的先解 */
  private boneDepth(name: string): number {
    const { rig } = this.ctx;
    let i = rig.boneIndex(name);
    let d = 0;
    while ((i = rig.getParentIndex(i)) >= 0) d++;
    return d;
  }
}

export function createSkeletonControls(options: SkeletonControlsOptions): SkeletonControls {
  return new SkeletonControls(options);
}
