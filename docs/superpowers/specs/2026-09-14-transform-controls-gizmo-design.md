# TransformControls 换芯设计：操纵器 gizmo 层替换 + 可配置快捷键

日期：2026-09-14
状态：已评审（方案 A，聊天中确认）

## 背景与目标

`src/controls/` 的操纵器体系当前全自研：`DragTarget`（位置球 + AxisArrows 轴箭头）、`RotateRings`（数学命中的旋转环）、`PoleOrbit`（pole 轨道球）。本设计把 **gizmo 层**（轴箭头、旋转环的渲染与拖拽交互）换成 three 自带的 `TransformControls`（下称 TC），IK 特有语义全部保留。

**明确保留**：选中机制（Maya 同款单选）、W/E 模式切换、钳制管线（可达球/方向锥/轨道投影）、携带（carry-along）、PoleOrbit 轨道逻辑、modifier 排序与首解流程、增量通道（肘/肩环累计角）。

**明确不做**：不接入 TC 的 scale 模式（骨骼缩放在现有语义下无意义）；不改 modifier 层；公共 API 尽量不动（允许的 breaking 见第 5 节）。

附带需求：W/E 快捷键从 playground 收进库，做成可配置/可关闭，方便嵌入其他系统时兼容宿主快捷键体系（第 7 节）。

## 1. 架构：ManipulatorDriver 接口 + TC 适配器

装配器（SkeletonControls）不直接依赖 TC，而是依赖一个窄接口：

```ts
export interface ManipulatorDriver {
  setMode(mode: 'translate' | 'rotate'): void;
  attach(obj: Object3D | null): void; // null = detach
  readonly attachedTo: Object3D | null;
  onDragStart?: (axis: string | null) => void; // TC axis: 'X'|'Y'|'Z'|'E'|'XYZE'|…
  onDragChange?: () => void;
  onDragEnd?: () => void;
  onDraggingChanged?: (dragging: boolean) => void; // 接 dragControl 视角锁
  dispose(): void;
}
```

- `TransformControlsDriver`（新文件 `src/controls/transform-controls-driver.ts`）：生产实现。内部 `new TransformControls(camera, dom)`，把 TC 的 `mouseDown`/`objectChange`/`mouseUp`/`dragging-changed` 翻译成接口回调；`dragging-changed` 同时接 `dragControl.lock/unlock`。
- node 测试传 fake driver——**SkeletonControls 与 kinds 不需要真实 DOM 的 TC**，现有 DragDom 桩测试体系存活。
- `SkeletonControlsOptions` 新增可选 `manipulator?: ManipulatorDriver`；缺省内部构造 TC 适配器（需要真实 `dom`，playground 传 `renderer.domElement` 即满足）。

### TC 版本兼容（getHelper shim）

peer `three: >=0.160.0` 保持不变。r169 起 TC 重构为 `Controls` 基类、不再是 Object3D，挂场景用 `getHelper()`；此前直接 `scene.add(tc)`。适配器内一行 shim：

```ts
scene.add(typeof tc.getHelper === 'function' ? tc.getHelper() : tc as unknown as Object3D);
```

事件名（`dragging-changed`/`objectChange`/`mouseDown`/`mouseUp`）与 `attach/detach/setMode/showX…` 在 r160–r170 稳定。

## 2. DragTarget / PoleOrbit：留本体，删 gizmo

### DragTarget

- **删**：`setAxisHandles`、AxisArrows 字段与轴拖拽路径、`updateFrame`（箭头屏幕恒定缩放）。`axis-arrows.ts` 整文件删除。
- **留**：球体渲染、钳制管线（`applyConstraints` 可达球/方向锥）、携带（`setCarry`/`carryAlong`）、marker/selected 态、`onPress`、`setColor`、**自身中心球的平面自由拖**。
  - 平面自由拖是「控制对象」的交互而非 gizmo，且保住「未选中的球一把拖起」的首手势体验：TC 要选中 attach 后才接管，首击 pointerdown 已发生、TC 无法中途抢手势——首击 = 选中 + 自由拖（现状同款），第二击起由 TC 接管（轴箭头可用）。
- **加**（外部操纵器接管面）：
  - `beginExternalDrag()`：置拖拽态（`carryAlong` 暂停，与现有 `dragging` 语义一致；`isDragging` 为 true）。
  - `endExternalDrag()`：复位，刷新携带偏移。
  - `reclamp()`：把（TC 直接写入的）当前位置公开地过一遍 `applyConstraints` 回写——**钳制逻辑零改动复用**（内部即现有 `snapIntoConstraints` 提为公开）。
- TC attach 期间 DragTarget 自身的拖拽禁用（`onPress` 选中上报保留），避免与 TC 中心自由移动双重捕获。

### PoleOrbit

- 轨道几何（`setOrbitFrame`/`setDirection`/落位投影/径向死区）、`onRadiusDrag`、marker 模式、`onPress`、自身轨道自由拖——**全部不动**。
- **删**：AxisArrows 相关（`setAxisHandles`、轴拖拽路径）。
- **加**同款三方法；`reclamp()` 语义 = 把外部写入的位置按轨道逻辑落回：投影出角度（写 `dir`）与径向（超死区触发 `onRadiusDrag`），与现在轴箭头拖拽的「单轴移动自然分解为角度+径向」同语义。

## 3. RotateRings → 无头朝向 proxy

类名与导出不换（减小 churn），但删掉全部 torus 渲染、数学命中 picking、指针监听、视角环 mesh、后半环染灰 shader、屏幕恒定缩放（这些由 TC rotate gizmo 接管）。

- **留**：`setJoint`（环心跟随关节）、`setOrientationCarry`（FK 朝向携带 + `localOffset`）、`orientationSource`、`update()`（非拖拽时按 朝向源/携带父骨/关节 优先级写朝向）。
- **改**：`onRotateDrag` 单钩子 → 三钩子：
  - `onDragStart(axisWorld: Vector3)`：kinds 的快照捕获从 `onPress` 挪到这里（肘环 `rollBase`/`_elbow0`/`_fore0`、肩环三点 + pole 偏好快照）。
  - `onDragDelta(axisIndex: number, totalAngle: number, axisWorld: Vector3)`：语义同现 `onRotateDrag`（累计角，非逐事件增量）。
  - `onDragEnd()`：增量模式的 proxy 朝向回落 `orientationSource`。
- **加**（TC 驱动的增量角提取，proxy 内部、node 可测）：
  - `beginExternalDrag(axisIndex: number, axisWorld: Vector3)`：快照自身世界四元数与拖轴。
  - `updateExternalDrag()`：读当前世界四元数，`delta = q_cur × q_start⁻¹`，对冻结拖轴做 **swing-twist 分解**取累计 twist 角，调 `onDragDelta`。TC local 空间绕轴转不改变该轴方向，拖轴天然冻结。
  - 朝向模式（bone/root/端骨环，非增量）：`updateExternalDrag()` 改为重捕 `localOffset`（`carryParent` 存在时），CopyTransformModifier 链路不动。
- **已知观感差异**：增量模式拖拽中环跟手转（现在只高亮不转）。twist 环绕自身轴转视觉不可见；bend 环跟手是更好的反馈。接受。
- **轴子集与杂项通道**：肘环只要 X/Y 两轴 → TC `showZ=false`；TC 的 `'E'`（视角环）/`'XYZE'`（自由轨球）在 `onDragStart` 判定 `axis` 并拒绝（等效现 `viewRing: false`；需要视角环的场景后续再开放）。

## 4. SkeletonControls：attach 路由

`applyView` 从「逐个操纵器切显隐」改为「按 选中态 × 模式 算出 （目标对象， TC 模式）」：

| 选中态 | W (move) | E (rotate) |
|---|---|---|
| 双通道主选中（limb 端球） | translate → 端球 | rotate → 端骨环 proxy |
| 纯位置主选中（lookAt/chain） | translate → 球 | translate → 球（现行为：纯位置不受模式影响） |
| 纯旋转主选中（bone，`rotationOnly`） | rotate → 环 proxy（不看 W/E） | 同左 |
| 子选中 `:elbow` | translate → pole 球 | rotate → 肘环 proxy |
| 子选中 `:root`（肩/髋，`rotationOnly`） | rotate → 肩环 proxy | 同左 |
| 无选中 | detach | detach |

### BuiltControl 操纵器描述泛化

```ts
// 可被外部操纵器拖拽的对象面（DragTarget/PoleOrbit 实现）
export interface ExternalDraggable {
  beginExternalDrag(): void;
  endExternalDrag(): void;
  reclamp(): void;
}

interface BuiltControl {
  // …现有字段（rotateRings 元素类型仍为 RotateRings，已是 proxy）
  /** 子选中目标的 move 通道挂载点（如 limb 肘部的 pole 球） */
  subMoveTargets?: { key: string; target: Object3D & ExternalDraggable }[];
}
```

`DragTarget`/`PoleOrbit` 实现 `ExternalDraggable`；`RotateRings` proxy 暴露 `beginExternalDrag/updateExternalDrag/endExternalDrag`。

### 事件接线（装配器）

- driver `onDragStart(axis)`：置 `pressClaimed`（空白失焦防线）；按 attach 对象类型分派——球类 `beginExternalDrag()`；proxy 类解析 `axis`→`axisIndex`（`'X'/'Y'/'Z'`→0/1/2；`'E'/'XYZE'` 且该 proxy 禁用视角环 → `event` 拒绝/忽略）后 `beginExternalDrag`。
- driver `onDragChange()`：球类 `reclamp()`；proxy 类 `updateExternalDrag()`。
- driver `onDragEnd()`：`endExternalDrag()` 对称调用。
- driver `onDraggingChanged`：接 `dragControl.lock/unlock`（playground 视角锁）。
- 球的 marker/selected 高亮、空白失焦（pointerdown 注册顺序技巧）、W/E、modifier 深度排序、首解 `rig.update(0)`——全部不动。
- `ctl.update()`：删 `updateFrame` 调用（随 AxisArrows 消失），其余不变。

## 5. 公共 API 影响

Breaking（包处于 0.0.x，可接受；README 同步）：

- `DragTarget.setAxisHandles` 删除；`PoleOrbit.setAxisHandles` 删除。
- `RotateRings` 构造签名变化（不再需要 `camera`/`dom` 指针参数）；渲染相关方法（`setInteractive`/`setVisible`/`depthUniforms`）删除，显隐由 attach 路由接管。
- `AxisArrows` 从未从包入口导出，随文件消失，无入口变化。

保留不变：`MARKER_SCALE`、`MARKER_SELECTED_COLOR`、`setColor`、`moveTo`、钳制/携带面、`registerControlKind` 自定义 kind 体系（自定义 kind 获得的能力面随 `BuiltControl` 泛化同步扩大）。

入口新增导出：`ManipulatorDriver`、`ExternalDraggable`、`HotkeyMap`（下节）。

## 6. 测试与 playground

- `tests/controls/rotate-rings.test.ts` 重写：朝向携带、orientationSource 优先级、swing-twist 累计角提取（给定起止四元数断言角度与方向）——纯数学，node 可测。
- `tests/controls/drag-target.test.ts`：删轴箭头用例；钳制/携带/marker 用例保留；新增 `reclamp` 与 external-drag 期间 `carryAlong` 暂停的用例。
- `tests/controls/skeleton-controls.test.ts`：fake ManipulatorDriver 断言 attach 路由表六种形态 + `pressClaimed`/视角锁接线 + `hotkeys` 行为（第 7 节）。
- `tests/public-api.test.ts` 同步增删。
- playground：`tab-ik.ts` 删自有 keydown（见第 7 节）；视觉对照（TC 轴色 X红/Y绿/Z蓝与现状一致；环/箭头大小用 `tc.size` 调到与现观感相近）。

## 7. 可配置快捷键

W/E/Escape 目前只在 playground（`tab-ik.ts`）。收进库：

```ts
export interface HotkeyMap {
  /** 切 move 模式，默认 'w' */
  move?: string | string[];
  /** 切 rotate 模式，默认 'e' */
  rotate?: string | string[];
  /** 取消选中，默认 'Escape' */
  deselect?: string | string[];
}

interface SkeletonControlsOptions {
  /** 快捷键表；false = 完全关闭内置监听（宿主用 setManipulatorMode/select(null) 自绑，能力等价）。缺省 = 默认表 */
  hotkeys?: HotkeyMap | false;
  /** 键盘事件宿主，缺省 window（若存在）；node 测试传桩。嵌入方要限定监听范围走这里 */
  hotkeyTarget?: {
    addEventListener(type: 'keydown', listener: (e: { key: string; repeat: boolean; target: unknown }) => void): void;
    removeEventListener(type: 'keydown', listener: (e: never) => void): void;
  };
}
```

- **匹配**：`event.key` 大小写不敏感；数组 = 一个动作绑多键（如 `move: ['w', '1']`）。
- **运行期**：`ctl.setHotkeys(map | false)` 换绑/关闭；`dispose()` 自动解绑。
- **防坑内置**：忽略 `e.repeat`；事件源是可编辑元素（input/textarea/contenteditable）时不响应。
- playground `tab-ik.ts` 删自有监听，改用内置默认——行为不变，代码变少，顺带当首个验证者。

## 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/controls/transform-controls-driver.ts` | **新增**：TC 适配器 + getHelper shim |
| `src/controls/axis-arrows.ts` | **删除** |
| `src/controls/drag-target.ts` | 删 AxisArrows/轴拖拽；加 `beginExternalDrag/endExternalDrag/reclamp` |
| `src/controls/pole-orbit.ts` | 删 AxisArrows/轴拖拽；加同款三方法（reclamp = 轨道落回 + 径向分解） |
| `src/controls/rotate-rings.ts` | 重写为无头 proxy（删渲染/picking/指针；加增量角提取与三钩子） |
| `src/controls/types.ts` | `ExternalDraggable`、`BuiltControl.subMoveTargets`、`ManipulatorDriver`、`HotkeyMap` |
| `src/controls/skeleton-controls.ts` | attach 路由、driver 事件接线、hotkeys 监听、`setHotkeys` |
| `src/controls/index.ts` | 导出新类型 |
| `src/controls/kinds/*.ts` | 快照捕获从 `onPress` 挪 `onDragStart`；`onRotateDrag`→`onDragDelta`；limb 注册 `subMoveTargets`（pole） |
| `README.md` | 接入指南同步（breaking 点 + hotkeys） |
| `playground/src/tab-ik.ts` | 删自有 keydown |
| `tests/controls/*`、`tests/public-api.test.ts` | 见第 6 节 |
