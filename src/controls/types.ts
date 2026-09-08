import { Bone, Camera, Object3D, Vector3 } from 'three';
import type { SkeletonRig } from '../core/skeleton-rig';
import type { Modifier } from '../modifiers/modifier';
import type { DragControl, DragDom, DragTarget } from './drag-target';
import type { RotateRings } from './rotate-rings';

/** 全局默认钳制参数（spec 逐项覆盖；均为装配后可经句柄继续调节的初值） */
export interface ControlsDefaults {
  /** 位置球可达半径倍率，默认 1 */
  reachScale?: number;
  /** 带 pole 双骨链（四肢）的伸展上限倍率，默认 1（不收缩）：PoleOrbit 恒把 pole 球钉在
   *  ⊥ 链轴的轨道上，完全伸直时 roll 修正仍能把肘/膝方向带过退化点（实测弯→伸→弯稳定）；
   *  <1 则永远保留一点弯度（0.96 会在短骨链上摆出肉眼可见的 15°+ 上臂/大腿摆角，慎用） */
  poleKeepAlive?: number;
  /** 注视球恒距半径，默认 0.35（下限 0.3：CCD 端骨离颈 ~0.12m，再近注视退化成摆放端骨） */
  lookAtRadius?: number;
  /** 注视方向锥半角（°），默认 105 */
  lookAtAngleDeg?: number;
  /** 根骨（重心）活动球域半径，默认 0.4 */
  rootRadius?: number;
  /** 拖球视觉半径，默认 0.0225 */
  ballRadius?: number;
  /** 旋转环半径（世界坐标），默认 0.16 */
  ringRadius?: number;
}

export type ResolvedDefaults = Required<ControlsDefaults>;

/** 控制点声明的公共字段；内置 kind 见 kinds/ 下各 spec */
export interface ControlSpecBase {
  /** 唯一名（ctl.get(name) 取值） */
  name: string;
  kind: string;
  /** 球颜色（16 进制） */
  color?: number;
  /** 初始位置（世界坐标）；缺省按 kind 自动摆位（端骨世界位置 / 关节 + 锥轴×半径） */
  position?: Vector3 | [number, number, number];
  /** 视觉球半径（默认 defaults.ballRadius） */
  ballRadius?: number;
}

/** kind 构建期的服务上下文（装配器注入，自定义 kind 同款可用） */
export interface ControlBuildContext {
  rig: SkeletonRig;
  /** 控制球/引导线挂点（世界坐标定位） */
  scene: Object3D;
  camera: Camera;
  dom: DragDom;
  dragControl?: DragControl;
  /** 角色朝向（世界系单位向量）：方向锥轴与 pole 自动摆位的参照 */
  facing: Vector3;
  defaults: ResolvedDefaults;
  /** 按名取骨（找不到抛 BONE_NOT_FOUND） */
  bone(name: string): Bone;
  /** 选中机制（Maya 同款：只有选中的控制点显示操纵器）：kind 把每个操纵器的 onPress 挂到这里 */
  select(name: string): void;
  /** 只认领按下、不改选中（空白失焦判定用）：pole 等「常驻纯位置操纵器」的 onPress 挂这里——
   *  点它不该把所属控制点（如手）的操纵器点亮，那会让用户误以为选中了手 */
  claim(): void;
}

/** 操纵器模式（Maya W/E）：move = 位置球，rotate = 旋转环（仅双通道控制点响应切换） */
export type ManipulatorMode = 'move' | 'rotate';

/** kind 工厂产物：装配器据此做 modifier 深度排序、首解、逐帧更新与清理 */
export interface BuiltControl {
  readonly name: string;
  readonly kind: string;
  /** 全部拖球（ctl.update 里统一 carryAlong） */
  readonly targets: DragTarget[];
  /** 旋转环（双通道控制点；装配器按操纵器模式切换 球↔环 的显示与交互） */
  readonly rotateRings?: RotateRings[];
  /** 参与 move 模式切换的球（缺省 = targets） */
  readonly moveTargets?: DragTarget[];
  /** modifier + 排序锚骨（按该骨在骨架中的深度决定求解顺序，浅的先解） */
  readonly modifiers: { modifier: Modifier; rootBone: string }[];
  /** 操纵器模式（W/E）切换钩子：不进 targets/rotateRings 体系的操纵器（如肘环↔pole 球换班）
   *  在此自行切显隐与交互；装配器在 build/select/setManipulatorMode 时逐个调用 */
  onModeChange?(mode: ManipulatorMode): void;
  /** 首解（rig.update(0)）之后调用：设钳制、捕获携带偏移、实测 poleDirection */
  postSolve(): void;
  /** 每帧调用（carryAlong 之后）：环跟随、引导线等 */
  update?(): void;
  readonly handle: ControlHandleBase;
  /** 移除场景对象并释放资源（modifier 由装配器统一 removeModifier） */
  dispose(): void;
}

export type ControlKindFactory<S extends ControlSpecBase = ControlSpecBase> = (ctx: ControlBuildContext, spec: S) => BuiltControl;

/** 参数调节句柄基座：GUI/外部绑定挂在上面，setter 立即生效（约束自带收拢） */
export interface ControlHandleBase {
  readonly name: string;
  readonly kind: string;
  /** 主拖球（旋转专用的 bone 控制点没有；kind 副操纵器见各具体句柄，如 limb 的 pole） */
  readonly target?: DragTarget;
  /** 求解器逃生口：active/influence/迭代参数等直接调 */
  readonly modifier: Modifier;
  setActive(active: boolean): void;
}

export function toVec3(v: Vector3 | [number, number, number]): Vector3 {
  return Array.isArray(v) ? new Vector3(v[0], v[1], v[2]) : v.clone();
}

/** 方向锥轴解析：'facing'/'backward' 相对角色朝向，或直接给世界向量 */
export function resolveConeAxis(axis: 'facing' | 'backward' | Vector3 | undefined, facing: Vector3): Vector3 {
  if (!axis || axis === 'facing') return facing.clone();
  if (axis === 'backward') return facing.clone().negate();
  return axis.clone().normalize();
}
