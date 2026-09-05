import { Camera, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../core/skeleton-rig';
import { ThreeIKError } from '../core/errors';
import { DragTarget, type DragControl, type DragDom } from './drag-target';
import { resolveCustomControlKind } from './registry';
import { buildRootControl, type RootControlSpec } from './kinds/root';
import { buildLimbControl, type LimbControlSpec } from './kinds/limb';
import { buildLookAtControl, type LookAtControlSpec } from './kinds/look-at';
import { buildChainControl, type ChainControlSpec } from './kinds/chain';
import type { BuiltControl, ControlBuildContext, ControlHandleBase, ControlKindFactory, ControlsDefaults, ControlSpecBase, ManipulatorMode } from './types';

export type BuiltinControlSpec = RootControlSpec | LimbControlSpec | LookAtControlSpec | ChainControlSpec;
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
};

/**
 * 骨架控制点装配器：声明式挂一整套拖球 + modifier，并把三条实测结论固化在流程里——
 *  1. modifier 按根骨在骨架中的深度排序（hips 搬全身最先解；spine 动肩膀必须先于手臂；
 *     同深度保持声明顺序）
 *  2. 装配时内部先跑一帧 rig.update(0)，钳制锚点/携带偏移/poleDirection 都按求解后姿势捕获
 *  3. limb 的 roll 修正实测（poleDirection:'auto'）是声明开关；pole 球是双通道转向球
 *     （move 模式拖 = 调弯曲量，rotate 模式拖 = 绕轴 swivel），随操纵器模式切换
 *
 * 应用侧每帧：`rig.update(dt)` 之后调 `ctl.update()`（携带 → pole 双通道 → 引导线）。
 */
export class SkeletonControls {
  private readonly controls = new Map<string, BuiltControl>();
  private readonly ctx: ControlBuildContext;
  private manipulatorMode: ManipulatorMode = 'move';

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
        reachScale: 1, poleKeepAlive: 0.96, poleRadius: 0.2, poleAngleDeg: 100,
        lookAtRadius: 0.35, lookAtAngleDeg: 105, rootRadius: 0.4, ballRadius: 0.0225, ringRadius: 0.08,
        ...options.defaults,
      },
      bone: (name) => rig.getBoneAt(rig.boneIndex(name)),
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
  }

  /** 每帧调用（rig.update 之后）：携带跟随 → pole 双通道 → 引导线 */
  update(): void {
    for (const c of this.controls.values()) {
      for (const t of c.targets) t.carryAlong();
      c.update?.();
    }
  }

  dispose(): void {
    for (const c of this.controls.values()) {
      for (const m of c.modifiers) this.ctx.rig.removeModifier(m.modifier);
      c.dispose();
    }
    this.controls.clear();
  }

  /** 操纵器模式切换（Maya W/E）：move = 位置球，rotate = 旋转环。
   *  仅带旋转通道的控制点响应（球藏起、环上场）；纯位置控制点两种模式下都保持可用 */
  setManipulatorMode(mode: ManipulatorMode): void {
    if (this.manipulatorMode === mode) return;
    this.manipulatorMode = mode;
    for (const c of this.controls.values()) this.applyManipulatorMode(c);
  }

  getManipulatorMode(): ManipulatorMode {
    return this.manipulatorMode;
  }

  private applyManipulatorMode(c: BuiltControl): void {
    c.setMode?.(this.manipulatorMode); // 双通道控制点（limb pole）无条件收模式
    if (!c.rotateRings?.length) return; // 无旋转通道：球/环不切换
    const move = this.manipulatorMode === 'move';
    for (const t of c.moveTargets ?? c.targets) {
      t.setInteractive(move);
      t.setVisible(move);
    }
    for (const r of c.rotateRings) {
      r.setInteractive(!move);
      r.setVisible(!move);
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
    this.applyManipulatorMode(c);
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
