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
import { RotateRings } from './rotate-rings';
import { TransformControlsDriver } from './transform-controls-driver';
import type { BuiltControl, ControlBuildContext, ControlHandleBase, ControlKindFactory, ControlsDefaults, ControlSpecBase, ExternalDraggable, HotkeyEvent, HotkeyMap, HotkeyTarget, ManipulatorDriver, ManipulatorMode } from './types';

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
  /** 外部操纵器驱动（缺省内部构造 TransformControlsDriver；node 测试传 fake） */
  manipulator?: ManipulatorDriver;
  /** 快捷键表；false = 关闭内置监听（宿主用 setManipulatorMode/select(null) 自绑）。缺省 = 默认表 */
  hotkeys?: HotkeyMap | false;
  /** 键盘事件宿主（缺省 window 若存在；node 测试传桩；嵌入方限定监听范围走这里） */
  hotkeyTarget?: HotkeyTarget;
  /** 模式变化回调（快捷键/GUI 任一入口切换都触发；playground 用它同步 GUI 下拉框） */
  onManipulatorModeChange?: (mode: ManipulatorMode) => void;
}

const BUILTINS: Record<string, ControlKindFactory> = {
  root: buildRootControl as ControlKindFactory,
  limb: buildLimbControl as ControlKindFactory,
  lookAt: buildLookAtControl as ControlKindFactory,
  chain: buildChainControl as ControlKindFactory,
  bone: buildBoneControl as ControlKindFactory,
};

/** 默认快捷键表：Maya W/E + Escape 取消选中 */
const DEFAULT_HOTKEYS: Required<HotkeyMap> = { move: ['w'], rotate: ['e'], deselect: ['Escape'] };

function toKeyArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

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
  private readonly driver: ManipulatorDriver;
  /** 当前 attach 的操控对象（事件分派用）：proxy = 旋转环，draggable = 平移通道拖球 */
  private currentManipulator: { draggable: ExternalDraggable; proxy?: undefined } | { proxy: RotateRings; draggable?: undefined } | null = null;
  private readonly onDomPointerDown: (e: DragPointerEvent) => void;
  private readonly onDomPointerMove: (e: DragPointerEvent) => void;
  private readonly onDomPointerUp: () => void;
  private readonly hotkeyTargetOption?: HotkeyTarget;
  private hotkeyTarget: HotkeyTarget | null = null;
  private hotkeyListener: ((e: HotkeyEvent) => void) | null = null;
  private readonly onModeChangeCallback?: (mode: ManipulatorMode) => void;

  constructor(options: SkeletonControlsOptions) {
    const { rig } = options;
    this.hotkeyTargetOption = options.hotkeyTarget;
    this.onModeChangeCallback = options.onManipulatorModeChange;
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

    // 外部操纵器驱动在 buildControl 循环之前创建：TC 的 dom 指针监听要先于控制点操纵器
    // 注册，保证同一轮 pointerdown 里 TC 认领（pressClaimed）先于装配器的空白失焦判定运行
    this.driver = options.manipulator ?? new TransformControlsDriver(options.camera, options.scene, options.dom, options.dragControl);
    this.driver.onDragStart = ({ axis }) => this.onManipulatorDragStart(axis);
    this.driver.onDragChange = () => this.onManipulatorDragChange();
    this.driver.onDragEnd = () => this.onManipulatorDragEnd();

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

    // 快捷键监听收尾注册（缺省表：W/E/Escape）；false = 交给宿主自绑
    this.setHotkeys(options.hotkeys ?? DEFAULT_HOTKEYS);
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
    // 先走 select(null)：内部 retarget 会 detach 挂在其对象上的外部操纵器，再dispose 场景对象
    if (this.selectedName === name || this.selectedName?.startsWith(name + ':')) this.select(null);
    const c = this.controls.get(name);
    if (!c) return;
    for (const m of c.modifiers) this.ctx.rig.removeModifier(m.modifier);
    c.dispose();
    this.controls.delete(name);
  }

  /** 每帧调用（rig.update 之后）：携带跟随 → 环跟随 → 引导线 */
  update(): void {
    for (const c of this.controls.values()) {
      for (const t of c.targets) t.carryAlong();
      c.update?.();
    }
  }

  dispose(): void {
    this.unbindHotkeys();
    this.dom.removeEventListener('pointerdown', this.onDomPointerDown);
    this.dom.removeEventListener('pointermove', this.onDomPointerMove);
    this.dom.removeEventListener('pointerup', this.onDomPointerUp);
    this.pendingBlur = null;
    this.driver.dispose();
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
    this.retargetManipulator();
    this.onModeChangeCallback?.(mode); // 只在实际变化后触发：GUI/键盘多入口互相同步且不空转
  }

  /** 快捷键绑定：map = 换绑（字段缺省回落默认表），false = 关闭。dispose 自动解绑 */
  setHotkeys(map: HotkeyMap | false): void {
    this.unbindHotkeys();
    if (map === false) return;
    // 库不依赖 DOM lib：window 只能从 globalThis 动态探测（node 环境无此全局）
    const g = globalThis as { window?: HotkeyTarget };
    const target = this.hotkeyTargetOption ?? (typeof g.window !== 'undefined' ? g.window : undefined);
    if (!target) return;
    const resolved = {
      move: toKeyArray(map.move ?? DEFAULT_HOTKEYS.move),
      rotate: toKeyArray(map.rotate ?? DEFAULT_HOTKEYS.rotate),
      deselect: toKeyArray(map.deselect ?? DEFAULT_HOTKEYS.deselect),
    };
    const match = (keys: string[], key: string) => keys.some((k) => k.toLowerCase() === key.toLowerCase());
    this.hotkeyListener = (e) => {
      if (e.repeat) return; // 长按不抖
      // 可编辑元素（input/textarea/contenteditable）里打字不触发——嵌入系统表单不打架
      const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (match(resolved.move, e.key)) this.setManipulatorMode('move');
      else if (match(resolved.rotate, e.key)) this.setManipulatorMode('rotate');
      else if (match(resolved.deselect, e.key)) this.select(null);
    };
    target.addEventListener('keydown', this.hotkeyListener);
    this.hotkeyTarget = target;
  }

  private unbindHotkeys(): void {
    if (this.hotkeyTarget && this.hotkeyListener) {
      this.hotkeyTarget.removeEventListener('keydown', this.hotkeyListener);
    }
    this.hotkeyTarget = null;
    this.hotkeyListener = null;
  }

  getManipulatorMode(): ManipulatorMode {
    return this.manipulatorMode;
  }

  /** 选中控制点（Maya 同款：只有选中的 attach 操纵器——move 模式 attach 位置通道、
   *  rotate 模式 attach 旋转环，纯位置控制点两种模式都 attach 位置通道）；
   *  传 null 取消选中。操纵器的 onPress 会自动调它（点哪个选中哪个）。
   *  支持子选中（`'name:sub'`）：limb 的肘/膝是独立选中目标（点 pole 球选中它），
   *  子选中时该子环组上场、主环收起，互不干扰 */
  select(name: string | null): void {
    if (name !== null) {
      const sep = name.indexOf(':');
      const main = sep < 0 ? name : name.slice(0, sep);
      const sub = sep < 0 ? null : name.slice(sep + 1);
      const c = this.controls.get(main);
      if (!c) return;
      if (sub !== null && !c.subRingGroups?.some((g) => g.key === sub)) return;
    }
    if (this.selectedName === name) return;
    this.selectedName = name;
    for (const c of this.controls.values()) this.applyView(c);
    this.retargetManipulator();
  }

  getSelected(): string | null {
    return this.selectedName;
  }

  /** 每个控制点的显隐规则：球/标记 = 控制对象（常显），选中高亮 = 标记变色；
   *  环的 attach/detach 归 retargetManipulator（外部操纵器接管，本方法不再碰环） */
  private applyView(c: BuiltControl): void {
    const move = this.manipulatorMode === 'move';
    const selected = this.selectedName === c.name;
    const subSelected = this.selectedName?.startsWith(c.name + ':')
      ? this.selectedName.slice(c.name.length + 1)
      : null;
    const hasRings = !!c.rotateRings?.length || !!c.subRingGroups?.length;
    for (const t of c.moveTargets ?? c.targets) {
      t.setVisible(true);
      t.setInteractive(true);
      // rotate 模式下双通道球退化成可点标记（选中入口，不可拖）；纯位置控制点不受模式影响
      t.setMarkerMode(!move && hasRings);
      t.setSelected(selected); // 只管标记高亮（选中变色），可拖性归 attach 路由
    }
    // 常驻标记球（不在 moveTargets 里的，如 bone/肩髋标记）：选中高亮，不看模式——
    // 纯旋转控制点在 W 模式点击的唯一即时反馈。kind 自己管理子选中标记的（limb 肩髋球），
    // 由后面的 onSelectionChange 覆盖（顺序保证后者生效）
    const moveSet = new Set(c.moveTargets ?? c.targets);
    for (const t of c.targets) {
      if (!moveSet.has(t)) t.setSelected(selected);
    }
    c.onModeChange?.(this.manipulatorMode); // 体系外操纵器（pole 球换班）
    c.onSelectionChange?.(subSelected); // 子选中钩子（limb 据此高亮肩/髋标记球）
  }

  /** 外部操纵器拖拽事件分派：按当前 attach 对象的类型走 proxy（旋转环）或 draggable（拖球）通道 */
  private onManipulatorDragStart(axis: string | null): void {
    this.pressClaimed = true; // 拖拽开始 = 本轮按下被认领（空白失焦防线）
    const cur = this.currentManipulator;
    if (!cur) return;
    if (cur.proxy) {
      const idx = axis === 'X' ? 0 : axis === 'Y' ? 1 : axis === 'Z' ? 2 : -1;
      if (idx < 0 && cur.proxy.onDragDelta) return; // 增量环不认 E/XYZE（配置层已隐藏，防御）
      cur.proxy.beginExternalDrag(idx);
    } else {
      cur.draggable.beginExternalDrag();
    }
  }

  private onManipulatorDragChange(): void {
    const cur = this.currentManipulator;
    if (!cur) return;
    if (cur.proxy) cur.proxy.updateExternalDrag();
    else cur.draggable.reclamp();
  }

  private onManipulatorDragEnd(): void {
    const cur = this.currentManipulator;
    if (!cur) return;
    if (cur.proxy) cur.proxy.endExternalDrag();
    else cur.draggable.endExternalDrag();
  }

  /** 按 选中态 × 操纵器模式 重挂外部操纵器；球的高亮/marker 逻辑仍在 applyView */
  private retargetManipulator(): void {
    const sel = this.selectedName;
    const c = sel ? this.controls.get(sel.split(':')[0]!) : undefined;
    if (!sel || !c) { this.attachManipulator(null); return; }
    const sub = sel.includes(':') ? sel.slice(sel.indexOf(':') + 1) : null;
    const move = this.manipulatorMode === 'move';
    if (sub !== null) {
      const g = c.subRingGroups?.find((g) => g.key === sub);
      if (g?.rings.length && (!move || !!g.rotationOnly)) { this.attachManipulator(g.rings[0]!); return; }
      const sm = c.subMoveTargets?.find((s) => s.key === sub);
      if (move && sm) { this.attachManipulator(sm.target); return; }
      this.attachManipulator(null);
      return;
    }
    const hasRings = !!c.rotateRings?.length;
    if (hasRings && (!move || !!c.rotationOnly)) { this.attachManipulator(c.rotateRings![0]!); return; }
    // move 模式的双通道/纯位置、rotate 模式的纯位置：平移通道（纯位置不受模式影响是现行为）
    const t = (c.moveTargets ?? c.targets)[0] ?? c.targets[0];
    this.attachManipulator(t ?? null);
  }

  /** obj 为 ExternalDraggable 或 RotateRings proxy；null = detach */
  private attachManipulator(obj: ExternalDraggable | RotateRings | null): void {
    // 旧对象让位标志复位
    if (this.currentManipulator?.draggable && this.currentManipulator.draggable !== obj) {
      this.currentManipulator.draggable.setExternalManipulator(false);
    }
    if (!obj) {
      this.currentManipulator = null;
      this.driver.attach(null);
      return;
    }
    if (obj instanceof RotateRings) {
      this.currentManipulator = { proxy: obj };
      this.driver.setMode('rotate');
      this.driver.attach(obj, { axes: obj.axisMask, viewRing: obj.viewRing, size: obj.manipulatorSize });
      return;
    }
    this.currentManipulator = { draggable: obj };
    obj.setExternalManipulator(true); // TC 接管期间自身拖拽让位（onPress 选中上报保留）
    this.driver.setMode('move');
    this.driver.attach(obj.dragObject, { size: obj.manipulatorSize });
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
