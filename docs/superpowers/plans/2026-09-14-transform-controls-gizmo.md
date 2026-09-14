# TransformControls 换芯 + 可配置快捷键 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把操纵器 gizmo 层（轴箭头/旋转环的渲染与拖拽交互）换成 three 自带 TransformControls，IK 特有语义（钳制/携带/选中/W-E/增量通道/pole 轨道）全部保留；W/E/Escape 快捷键收进库并可配置。

**Architecture:** 装配器（SkeletonControls）依赖窄接口 `ManipulatorDriver`，生产实现 `TransformControlsDriver` 包装 three 的 TransformControls（node 测试传 fake driver）。`DragTarget`/`PoleOrbit` 保留球体、钳制、携带与自身自由拖，新增「外部接管面」（`beginExternalDrag/endExternalDrag/reclamp/setExternalManipulator`）；`RotateRings` 重写为无头朝向 proxy（保留朝向携带/orientationSource，新增 swing-twist 增量角提取）。快捷键通过 `hotkeys` 选项配置，`false` 关闭。

**Tech Stack:** three ^0.170（dev）/ peer >=0.160、TypeScript、vitest（node 环境 + DOM 桩）、tsup。

**Spec:** `docs/superpowers/specs/2026-09-14-transform-controls-gizmo-design.md`

## Global Constraints

- peer 依赖 `three: >=0.160.0` **不变**；TC 挂场景用 getHelper shim：`typeof tc.getHelper === 'function' ? tc.getHelper() : tc`
- tsup `external` 必须从 `['three']` 改为 `[/^three/]`——`three/examples/jsm/controls/TransformControls.js` 子路径不得打进包里
- 不接入 TC 的 scale 模式；`ManipulatorMode` 保持 `'move' | 'rotate'`
- 注释用中文、风格与周边代码一致（注释解释「为什么」，不是复述代码）
- 每个 Task 结束 `npm test` 与 `npm run typecheck` 必须全绿再 commit
- 测试桩约定：`tests/controls/test-utils.ts` 的 `makeDomStub`（800×600 视口，默认指向中心 400,300）、`makeCamera`
- commit message 遵循仓库现有风格（`feat(controls): …` 中文描述），结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

---

### Task 1: DragTarget 外部接管面 + 拔除 AxisArrows

**Files:**
- Modify: `src/controls/types.ts`（新增 `ExternalDraggable` 接口）
- Modify: `src/controls/drag-target.ts`（加外部接管面，删 AxisArrows 全部代码）
- Modify: `src/controls/pole-orbit.ts`（删 AxisArrows 相关代码——它的外部接管面在 Task 2）
- Delete: `src/controls/axis-arrows.ts`
- Modify: `src/controls/kinds/root.ts`、`look-at.ts`、`chain.ts`、`limb.ts`（删 `setAxisHandles` 调用与 `pole.setSelected` 调用）
- Modify: `src/controls/skeleton-controls.ts`（`update()` 删 `updateFrame` 调用）
- Test: `tests/controls/drag-target.test.ts`（删轴箭头用例，加新用例）、`tests/controls/skeleton-controls.test.ts`（删「肘部轴箭头」用例，Task 5 重建等价覆盖）

**Interfaces:**
- Produces（后续 Task 依赖）：
  ```ts
  // types.ts
  /** 可被外部操纵器（TransformControls）直接改写的拖拽对象 */
  export interface ExternalDraggable {
    /** 外部操纵器 attach 的对象（通常 = 自身；PoleOrbit = 自身的 ball） */
    readonly dragObject: Object3D;
    /** 外部拖拽开始：置拖拽态（carryAlong 暂停，isDragging = true） */
    beginExternalDrag(): void;
    /** 外部拖拽结束：复位拖拽态并刷新携带偏移 */
    endExternalDrag(): void;
    /** 外部操纵器直接写入位置后调用：过约束管线回写（钳制逻辑复用现有 applyConstraints） */
    reclamp(): void;
    /** 外部操纵器接管期间：自身指针拖拽让位（onPress 选中上报保留） */
    setExternalManipulator(on: boolean): void;
    /** gizmo 尺寸倍率（相对各自类默认尺寸） */
    readonly manipulatorSize: number;
  }
  ```
  - `DragTarget implements ExternalDraggable`：`dragObject = this`；`manipulatorSize = ballRadius / DEFAULT_BALL_RADIUS`
  - 新导出常量 `DEFAULT_BALL_RADIUS = 0.0225`（drag-target.ts；构造默认 ballRadius 改引用它）
  - PoleOrbit 本任务只删箭头：`setAxisHandles`/`setSelected`/`syncArrowsVisibility`/轴拖拽分支/hover 分支全部删除；`HIT_TOLERANCE_PER_METER`（0.011）内联进 pole-orbit.ts（原来从 axis-arrows import）

- [ ] **Step 1: 写失败测试**

在 `tests/controls/drag-target.test.ts` 末尾的 `describe('DragTarget')` 内新增：

```ts
it('reclamp：外部写入的位置过钳制回写，携带偏移同步刷新', () => {
  const dom = makeDomStub();
  const camera = makeCamera();
  const scene = new Object3D();
  const anchor = new Object3D();
  scene.add(anchor);
  scene.updateMatrixWorld(true);
  const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
  scene.add(t);
  t.setReachConstraint(anchor, 0.5);
  t.setCarry(anchor);
  // 模拟外部操纵器（TC）直接改写位置——不经过拖拽路径
  t.position.set(2, 0, 0);
  t.reclamp();
  expect(t.position.length()).toBeCloseTo(0.5, 6); // 收回可达球面
  // 携带偏移按钳制后的实际位置重记：锚点平移后保持相对偏移
  anchor.position.set(1, 0, 0);
  anchor.updateMatrixWorld(true);
  t.carryAlong();
  expect(t.position.distanceTo(new Vector3(1.5, 0, 0))).toBeLessThan(1e-6);
});

it('外部拖拽期间 carryAlong 暂停、isDragging 为 true，endExternalDrag 后恢复', () => {
  const dom = makeDomStub();
  const camera = makeCamera();
  const scene = new Object3D();
  const anchor = new Object3D();
  scene.add(anchor);
  scene.updateMatrixWorld(true);
  const t = new DragTarget(camera, dom, new Vector3(0.3, 0, 0));
  scene.add(t);
  t.setCarry(anchor);
  t.beginExternalDrag();
  expect(t.isDragging).toBe(true);
  anchor.position.set(1, 0, 0);
  anchor.updateMatrixWorld(true);
  t.carryAlong();
  expect(t.position.x).toBeCloseTo(0.3, 6); // 拖拽中不携带
  t.endExternalDrag();
  expect(t.isDragging).toBe(false);
  t.carryAlong();
  expect(t.position.x).toBeCloseTo(1.3, 6); // 恢复携带
});

it('外部操纵器接管（setExternalManipulator）：按下只触发 onPress，不进入拖拽', () => {
  const dom = makeDomStub();
  const camera = makeCamera(); // 默认相机朝原点看：世界原点 = 屏幕中心 (400,300)
  const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
  const scene = new Object3D();
  scene.add(t);
  scene.updateMatrixWorld(true);
  const onPress = vi.fn();
  t.onPress = onPress;
  t.setExternalManipulator(true);
  dom.fire('pointerdown', {});
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(t.isDragging).toBe(false);
  dom.fire('pointermove', { clientX: 420, clientY: 300 });
  expect(t.position.length()).toBeLessThan(1e-6); // 没有拖动
});
```

同时**删除** drag-target.test.ts 中全部轴箭头用例（「轴箭头：拖 X 箭头…」「轴箭头：箭头根部让位中心球…」「轴箭头命中区…」「轴箭头高亮…」「轴箭头随球显隐…」），删除 skeleton-controls.test.ts 的「肘部轴箭头：W 模式选中肘部才上场…」用例（约 410 行起；等价覆盖在 Task 2/5 重建）。

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `npx vitest run tests/controls/drag-target.test.ts`
Expected: FAIL——`reclamp`/`beginExternalDrag`/`setExternalManipulator` is not a function

- [ ] **Step 3: 实现 types.ts + drag-target.ts**

types.ts 顶部 import 已有 `Object3D`；在 `ControlSpecBase` 之前插入 `ExternalDraggable` 接口（代码见上方 Interfaces 块）。

drag-target.ts 改动：

1. 删 `import { AxisArrows, HIT_TOLERANCE_PER_METER, MANIPULATOR_REF_DIST, rayAxisClosest } from './axis-arrows'`，改为自己定义：
   ```ts
   /** 命中容差（世界米/相机距离米）：raycast 缩小版球体容易脱靶（尤其触屏），按相机距离给射线余量 */
   const HIT_TOLERANCE_PER_METER = 0.011;
   /** 视觉球半径的类默认值（manipulatorSize 的基准；ControlsDefaults.ballRadius 缺省同值） */
   export const DEFAULT_BALL_RADIUS = 0.0225;
   ```
   删掉 `export { MANIPULATOR_REF_DIST };`（grep 确认无其他使用方；rotate-rings.ts 的 import 在 Task 3 移除——本任务 rotate-rings.ts 暂保留对 axis-arrows 的 import 会编译失败，所以**本任务同时删除 axis-arrows.ts 并处理 pole-orbit.ts；rotate-rings.ts 的 `MANIPULATOR_REF_DIST` import 临时改为本地常量** `const MANIPULATOR_REF_DIST = 3.5;` 并在文件顶部注释「Task 3 重写时随渲染代码一并删除」）。
2. 删字段 `arrowsOn`/`arrowLen`/`arrows`/`axisDragging`/`dragAxisVec`/`dragStartPos`/`dragAxisT0`，删方法 `setAxisHandles`/`syncArrowsVisibility`/`updateFrame`，删 `onPointerDown`/`onPointerMove`/`onPointerUp` 里的箭头分支（`arrows.pick`/`axisDragging` 段落与 hover 分支里的箭头部分）。
3. `setVisible` 删 `syncArrowsVisibility()` 调用；`setSelected` 只留 `syncMarkerAppearance()`；`dispose` 删 `arrows?.dispose()` 两行与 `axisDragging = false`。
4. 新增（放在 `moveTo` 之后）：
   ```ts
   /** 外部操纵器（TransformControls）接管面：TC attach 的对象即自身 */
   get dragObject(): Object3D { return this; }
   /** gizmo 尺寸倍率：相对类默认球半径 */
   get manipulatorSize(): number { return this.ballRadius / DEFAULT_BALL_RADIUS; }

   /** 外部拖拽开始（TC mouseDown）：复用 dragging 语义——carryAlong 暂停、isDragging = true */
   beginExternalDrag(): void {
     this.dragging = true;
   }

   /** 外部拖拽结束（TC mouseUp）：携带偏移按最终位置刷新 */
   endExternalDrag(): void {
     this.dragging = false;
     this.updateCarryOffset();
   }

   /** 外部操纵器直接写入位置后调用：过约束管线回写（钳制逻辑与指针拖拽同一条管线） */
   reclamp(): void {
     this.snapIntoConstraints();
   }

   /** 外部操纵器接管期间：自身指针拖拽让位（onPress 选中上报保留；markerMode 只挡拖拽，语义不同源） */
   setExternalManipulator(on: boolean): void {
     this.externalManipulator = on;
   }
   ```
   新增字段 `private externalManipulator = false;`；`onPointerDown` 中心球命中分支里 `if (this.markerMode) return;` 改为 `if (this.markerMode || this.externalManipulator) return;`。
5. `dispose()` 里补 `this.externalManipulator = false;`。

- [ ] **Step 4: 删 axis-arrows.ts + 处理 pole-orbit.ts 与 kinds 的编译**

- `git rm src/controls/axis-arrows.ts`
- pole-orbit.ts：删 `AxisArrows`/`rayAxisClosest` import（`HIT_TOLERANCE_PER_METER` 改为本地常量 `const HIT_TOLERANCE_PER_METER = 0.011;`），删 `arrowsOn`/`selected`/`arrows`/`axisDragging`/`dragStartBall`/`dragArrowAxis`/`dragAxisT0` 字段，删 `setAxisHandles`/`setSelected`/`syncArrowsVisibility` 方法，删 `onPointerDown`/`onPointerMove`/`onPointerUp` 的箭头分支，`place()` 末尾的箭头跟随块删除，`dispose` 删箭头两行。
- kinds：`root.ts:35`、`look-at.ts:42`、`chain.ts:37`、`limb.ts:112` 删 `target.setAxisHandles(true);` 行；`limb.ts:121` 删 `pole.setAxisHandles(true);`；limb.ts `onSelectionChange` 里删 `pole.setSelected(sub === 'elbow');` 行（保释肩/髋标记球行）。每处保留旁边注释中仍有信息量的部分（如「移动操纵器 Maya 化」注释随调用一起删，改在 Task 5 路由处统一注释）。
- skeleton-controls.ts `update()`：删 `for (const t of c.targets) t.updateFrame();` 行（含注释调整）。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿。若 skeleton-controls.test.ts 还有引用已删 API 的用例（grep `setAxisHandles\|axisDragging\|arrows` tests/），一并按 Task 语义删除或改写。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(controls): 拔除 AxisArrows——DragTarget/PoleOrbit 新增外部操纵器接管面

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: PoleOrbit 外部接管面

**Files:**
- Modify: `src/controls/pole-orbit.ts`
- Test: `tests/controls/drag-target.test.ts`（PoleOrbit 用例同文件现有惯例，如 33 行的 setColor 用例）

**Interfaces:**
- Consumes: Task 1 的 `ExternalDraggable`
- Produces: `PoleOrbit implements ExternalDraggable`——`dragObject = this.ball`（**不是 this**：PoleOrbit 本体原点在环心，视觉/操控对象是 ball 偏移）；`manipulatorSize = ballRadius / DEFAULT_BALL_RADIUS`。Task 5 的 attach 路由依赖 `dragObject`。

- [ ] **Step 1: 写失败测试**

在 drag-target.test.ts 追加（文件已 import PoleOrbit）：

```ts
it('PoleOrbit.reclamp：外部写入的球位置按轨道分解——方向写角度通道、半径超死区触发 onRadiusDrag', () => {
  const dom = makeDomStub();
  const scene = new Object3D();
  const from = new Object3D(); // 根骨：原点
  const to = new Object3D();   // 端球：链轴 = -Z
  to.position.set(0, 0, -1);
  scene.add(from, to);
  scene.updateMatrixWorld(true);
  const pole = new PoleOrbit(makeCamera(), dom, { ballRadius: 0.02 });
  scene.add(pole);
  pole.bind(from, to);
  pole.setOrbitFrame(0.5, 0.2); // 环心 = (0,0,-0.5)，半径 0.2
  pole.setDirection(new Vector3(1, 0, 0));
  pole.update();
  scene.updateMatrixWorld(true);
  expect(pole.ball.getWorldPosition(new Vector3()).distanceTo(new Vector3(0.2, 0, -0.5))).toBeLessThan(1e-6);

  const radii: number[] = [];
  pole.onRadiusDrag = (r) => radii.push(r);
  pole.beginExternalDrag();
  // 模拟 TC 直接挪球（ball.position 是 PoleOrbit 局部偏移，父恒等）：方向 X→Y，半径 0.2→0.4
  pole.ball.position.set(0, 0.4, 0);
  pole.reclamp();
  expect(radii).toHaveLength(1);
  expect(radii[0]).toBeCloseTo(0.4, 6);
  pole.endExternalDrag();
  // 落回轨道：环心 + 新方向 × 新半径（轴向分量被丢弃）
  pole.update();
  scene.updateMatrixWorld(true);
  expect(pole.ball.getWorldPosition(new Vector3()).distanceTo(new Vector3(0, 0.4, -0.5))).toBeLessThan(1e-6);
});

it('PoleOrbit.beginExternalDrag 期间 setOrbitFrame 不覆盖半径意图；setExternalManipulator 只留 onPress', () => {
  const dom = makeDomStub();
  const scene = new Object3D();
  const from = new Object3D();
  const to = new Object3D();
  to.position.set(0, 0, -1);
  scene.add(from, to);
  scene.updateMatrixWorld(true);
  const pole = new PoleOrbit(makeCamera(), dom, {});
  scene.add(pole);
  pole.bind(from, to);
  pole.setOrbitFrame(0.5, 0.2);
  pole.update();
  pole.beginExternalDrag();
  expect(pole.isDragging).toBe(true);
  pole.setOrbitFrame(0.5, 0.05); // 拖拽中：实测半径不覆盖用户意图
  pole.update();
  scene.updateMatrixWorld(true);
  expect(pole.ball.getWorldPosition(new Vector3()).sub(new Vector3(0, 0, -0.5)).length()).toBeCloseTo(0.2, 6);
  pole.endExternalDrag();

  // 接管期间按下只上报选中
  const onPress = vi.fn();
  pole.onPress = onPress;
  pole.setExternalManipulator(true);
  // 球世界位置 = (0, 0.2·dir…, -0.5)；setDirection(1,0,0) 后 = (0.2, 0, -0.5) → 投影到屏幕
  pole.setDirection(new Vector3(1, 0, 0));
  pole.update();
  scene.updateMatrixWorld(true);
  const cam = makeCamera(0.5, 1, 4, 0, 0, -0.5); // 斜置相机，避免退化
  void cam; // 命中走 pole 构造时的 camera；下面用 makeCamera() 默认相机重算屏幕点
  const p = pole.ball.getWorldPosition(new Vector3()).project(makeCamera());
  dom.fire('pointerdown', { clientX: ((p.x + 1) / 2) * 800, clientY: ((-p.y + 1) / 2) * 600 });
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(pole.isDragging).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/controls/drag-target.test.ts`
Expected: FAIL——`beginExternalDrag`/`reclamp`/`setExternalManipulator` is not a function

- [ ] **Step 3: 实现 pole-orbit.ts**

```ts
import { DEFAULT_BALL_RADIUS, type DragControl, type DragDom, type DragPointerEvent } from './drag-target';
import type { ExternalDraggable } from './types';

// 类声明：
export class PoleOrbit extends Object3D implements ExternalDraggable {
```

新增字段 `private externalManipulator = false;`；`onPointerDown` 里 `if (this.markerMode) return;` 改为 `if (this.markerMode || this.externalManipulator) return;`。

新增方法（放在 `setColor` 之后）：

```ts
/** 外部操纵器（TransformControls）attach 的对象：球本体（PoleOrbit 原点 = 环心，不是操控对象） */
get dragObject(): Object3D { return this.ball; }
get manipulatorSize(): number { return this.ballRadius / DEFAULT_BALL_RADIUS; }

/** 外部拖拽开始：置拖拽态（setOrbitFrame 不再覆盖半径意图），死区基准与显示半径一致 */
beginExternalDrag(): void {
  this.dragging = true;
  this.lastDragRadius = Math.max(this.orbitRadius, MIN_POLE_RADIUS);
}

endExternalDrag(): void {
  this.dragging = false;
}

/** 外部操纵器直接写入球位置后调用：按轨道语义分解落回——⊥链轴方向写角度通道（dir）、
 *  模长写径向通道（超死区触发 onRadiusDrag）、轴向分量丢弃（沿链轴挪球无意义）。
 *  用活架不用冻结架：掠射暴走是射线命中面的问题，TC 直接写位置没有这个问题 */
reclamp(): void {
  if (!this.frame(_center, _axis)) return;
  this.ball.getWorldPosition(_w).sub(_center);
  _w.addScaledVector(_axis, -_w.dot(_axis));
  if (_w.lengthSq() < 1e-12) { this.place(); return; }
  const radius = _w.length();
  this.dir.copy(_w).divideScalar(radius);
  this.orbitRadius = radius;
  if (Math.abs(radius - this.lastDragRadius) > RADIUS_DRAG_DEADZONE) {
    this.lastDragRadius = radius;
    this.onRadiusDrag?.(radius);
  }
  this.place();
}

setExternalManipulator(on: boolean): void {
  this.externalManipulator = on;
}
```

`dispose()` 补 `this.externalManipulator = false;`。

- [ ] **Step 4: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(controls): PoleOrbit 外部操纵器接管面——TC 直写球位置按轨道分解落回

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: RotateRings → 无头朝向 proxy

**Files:**
- Rewrite: `src/controls/rotate-rings.ts`（删全部渲染/picking/指针代码）
- Modify: `src/controls/kinds/limb.ts`、`root.ts`、`bone.ts`（新构造签名；`onRotateDrag`→`onDragDelta`；快照捕获从 `onPress` 挪 `onDragStart`；删 rings 的 `onPress` 选中）
- Rewrite: `tests/controls/rotate-rings.test.ts`
- Modify: `tests/controls/skeleton-controls.test.ts`（环拖拽用例改直驱 proxy）

**Interfaces:**
- Produces（Task 5 依赖）：
  ```ts
  export interface RotateRingsOptions {
    ringRadius?: number; // 默认 DEFAULT_RING_RADIUS = 0.16；仅作 gizmo 尺寸提示（manipulatorSize）
    rings?: number[];    // 启用轴子集（0-2），缺省全 3 轴 → axisMask
    viewRing?: boolean;  // 视角环（TC 'E' 通道），缺省 true
  }
  export class RotateRings extends Object3D {
    readonly ringRadius: number;
    readonly axisMask: [boolean, boolean, boolean];
    readonly viewRing: boolean;
    readonly manipulatorSize: number; // ringRadius / DEFAULT_RING_RADIUS
    readonly isDragging: boolean;
    setJoint(joint: Object3D): void;
    setOrientationCarry(parent: Object3D): void;
    orientationSource?: (out: Quaternion) => void;
    onDragStart?: (axisIndex: number, axisWorld: Vector3) => void;
    onDragDelta?: (axisIndex: number, totalAngle: number, axisWorld: Vector3) => void;
    onDragEnd?: () => void;
    /** 外部操纵器拖拽开始；axisIndex：0-2（'X'/'Y'/'Z'），-1 = 视角环 E（仅朝向模式可接受） */
    beginExternalDrag(axisIndex: number): void;
    /** TC objectChange 时调用：增量模式提取累计角调 onDragDelta；朝向模式重捕携带 localOffset */
    updateExternalDrag(): void;
    endExternalDrag(): void;
    update(): void;
    dispose(): void;
    /** @deprecated 过渡兼容（Task 5 移除）：显隐由装配器 attach 路由接管 */
    setVisible(v: boolean): void;
    /** @deprecated 过渡兼容（Task 5 移除）：no-op */
    setInteractive(v: boolean): void;
  }
  ```
  - 新导出常量 `DEFAULT_RING_RADIUS = 0.16`
  - 模式区分沿用旧规则：**设了 `onDragDelta` = 增量模式**（拖环不改写自身朝向语义，累计角交外部通道），否则朝向模式（自身世界四元数 = 期望骨骼朝向，CopyTransform 驱动）

- [ ] **Step 1: 重写 rotate-rings.test.ts（整文件替换）**

```ts
import { describe, it, expect, vi } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RotateRings } from '../../src/controls/rotate-rings';

const worldQuat = (o: Object3D) => o.getWorldQuaternion(new Quaternion());
const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

function makeProxy(jointPos = new Vector3(0, 0, 0)) {
  const scene = new Object3D();
  const joint = new Object3D();
  joint.position.copy(jointPos);
  scene.add(joint);
  const rings = new RotateRings();
  scene.add(rings);
  rings.setJoint(joint);
  rings.update();
  scene.updateMatrixWorld(true);
  return { scene, joint, rings };
}

/** 模拟 TC 的旋转写入：q_world' = axisAngle(axisWorld, angle) × q_world_start（父 = 场景顶层，quaternion 即世界） */
function simulateTCRotate(rings: RotateRings, axisIndex: number, angle: number, startQuat: Quaternion) {
  const axisWorld = AXES[axisIndex]!.clone().applyQuaternion(startQuat);
  rings.quaternion.copy(new Quaternion().setFromAxisAngle(axisWorld, angle).multiply(startQuat));
}

describe('RotateRings（无头朝向 proxy）', () => {
  it('跟随关节：update 把 proxy 搬到关节位置；非拖拽朝向同步关节', () => {
    const { joint, rings } = makeProxy(new Vector3(1, 2, 3));
    expect(rings.getWorldPosition(new Vector3()).distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    joint.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    joint.updateMatrixWorld(true);
    rings.update();
    const q = worldQuat(rings);
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('朝向携带（FK）：父骨转动时朝向 = 父 × localOffset；updateExternalDrag 重捕局部偏移', () => {
    const { scene, joint, rings } = makeProxy();
    const parent = new Object3D();
    scene.add(parent);
    parent.add(joint); // joint 改挂 parent 下
    scene.updateMatrixWorld(true);
    rings.setOrientationCarry(parent);
    // 父转 90°：proxy 跟随（保持局部偏移）
    parent.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    scene.updateMatrixWorld(true);
    rings.update();
    expect(worldQuat(rings).y).toBeCloseTo(Math.SQRT1_2, 6);
    // 外部操纵器把 proxy 再转 90°（绕世界 Y）→ updateExternalDrag 重捕 localOffset
    const start = worldQuat(rings);
    rings.beginExternalDrag(1);
    rings.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).multiply(start));
    rings.updateExternalDrag();
    rings.endExternalDrag();
    // 父回到恒等：proxy 应保持「用户转过的」局部偏移（总 90°，不弹回）
    parent.quaternion.identity();
    scene.updateMatrixWorld(true);
    rings.update();
    expect(worldQuat(rings).y).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('orientationSource 优先级高于携带与关节同步', () => {
    const { joint, rings } = makeProxy();
    rings.orientationSource = (out) => out.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    joint.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1);
    joint.updateMatrixWorld(true);
    rings.update();
    expect(worldQuat(rings).x).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('增量模式：updateExternalDrag 提取绕冻结拖轴的累计角（swing-twist）', () => {
    const { rings } = makeProxy();
    const deltas: Array<[number, number]> = [];
    rings.onDragDelta = (axisIndex, angle) => deltas.push([axisIndex, angle]);
    const onDragStart = vi.fn();
    rings.onDragStart = onDragStart;
    const start = worldQuat(rings);
    rings.beginExternalDrag(0); // X 环
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0]![0]).toBe(0);
    expect(onDragStart.mock.calls[0]![1].distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-6);
    simulateTCRotate(rings, 0, Math.PI / 2, start);
    rings.updateExternalDrag();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]![1]).toBeCloseTo(Math.PI / 2, 6);
    // 反向再转 -90°：累计角回 0
    simulateTCRotate(rings, 0, 0, start);
    rings.updateExternalDrag();
    expect(deltas[1]![1]).toBeCloseTo(0, 6);
    rings.endExternalDrag();
  });

  it('增量模式：逐次差分累计支持多圈拖拽（单次 270° 与三次 90° 同效）', () => {
    const { rings } = makeProxy();
    const angles: number[] = [];
    rings.onDragDelta = (_a, angle) => angles.push(angle);
    const start = worldQuat(rings);
    rings.beginExternalDrag(1);
    simulateTCRotate(rings, 1, Math.PI * 1.5, start); // 一步 270°
    rings.updateExternalDrag();
    expect(angles[0]).toBeCloseTo(Math.PI * 1.5, 6);
    rings.endExternalDrag();
  });

  it('增量模式：拖拽中 update 不写朝向（TC 接管），endExternalDrag 回落 orientationSource', () => {
    const { joint, rings } = makeProxy();
    rings.orientationSource = (out) => out.identity();
    joint.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 2);
    joint.updateMatrixWorld(true);
    rings.onDragDelta = () => {};
    rings.beginExternalDrag(2);
    rings.update();
    // 拖拽中：朝向不被 orientationSource 覆写（保持 begin 时快照姿态附近；TC 未写就恒等）
    expect(worldQuat(rings).z).toBeCloseTo(0, 6);
    rings.endExternalDrag(); // 松手回落朝向源（恒等）
    expect(worldQuat(rings).z).toBeCloseTo(0, 6);
  });

  it('增量模式拖拽中 proxy 跟手转（TC 写入的朝向不被 update 覆写）', () => {
    const { rings } = makeProxy();
    rings.onDragDelta = () => {};
    const start = worldQuat(rings);
    rings.beginExternalDrag(0);
    simulateTCRotate(rings, 0, Math.PI / 4, start);
    rings.update(); // 拖拽中不写朝向
    expect(worldQuat(rings).x).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    rings.endExternalDrag();
  });

  it('轴子集与视角环配置暴露给 driver（elbow 环：X/Y，无视角环）', () => {
    const rings = new RotateRings({ rings: [0, 1], viewRing: false, ringRadius: 0.32 });
    expect(rings.axisMask).toEqual([true, true, false]);
    expect(rings.viewRing).toBe(false);
    expect(rings.manipulatorSize).toBeCloseTo(2, 6);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/controls/rotate-rings.test.ts`
Expected: FAIL——`beginExternalDrag` is not a function 等

- [ ] **Step 3: 整文件重写 rotate-rings.ts**

```ts
import { Object3D, Quaternion, Vector3 } from 'three';

/** 旋转环半径的类默认值（manipulatorSize 基准；ControlsDefaults.ringRadius 缺省同值） */
export const DEFAULT_RING_RADIUS = 0.16;

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

const _c = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();
const _dq = new Quaternion();

/** 把 v 包装回 (−π, π]（逐次角度差分，防跨 ±π 跳变） */
function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export interface RotateRingsOptions {
  /** 环半径（仅作 gizmo 尺寸提示——渲染归 TransformControls，本类不再渲染） */
  ringRadius?: number;
  /** 只启用这些轴（0-2 的子集，缺省全 3 轴）：二维操纵器（如肘环）用 → driver 的 showX/Y/Z */
  rings?: number[];
  /** 视角环（TC 'E' 通道）开关，默认 true */
  viewRing?: boolean;
}

/**
 * 旋转朝向 proxy（无头）：渲染与指针交互由 TransformControls 接管（装配器 attach 路由），
 * 本类只保留 IK 语义——
 *  朝向模式（默认）：本对象的世界四元数即「期望的骨骼全局朝向」，CopyTransformModifier
 *    (referenceObject: rings, copyRotation) 据此驱动骨骼。朝向来源两选一——
 *     setOrientationCarry（FK 语义，掰骨控制点标配）：朝向 = 父骨世界朝向 × 局部偏移。
 *       父骨转动时端骨跟着相对转动，不钉绝对世界朝向；局部偏移初始 = 关节静止局部四元数，
 *       外部拖拽（updateExternalDrag）时逐帧重捕；
 *     默认（未设携带）：非拖拽时每帧从关节世界朝向同步（跟随求解结果）。
 *  增量模式（设了 onDragDelta）：TC 转出的自身朝向只作拖拽反馈，不改语义；改为回调
 *   「按下以来的累计角」（驱动外部通道用，如肘环 → 前臂旋转/伸缩）；朝向由 orientationSource
 *    逐帧供给，松手（endExternalDrag）回落。累计角用「逐次 twist 差分累计」而非四元数直解——
 *    直解在 |angle|>π 处回绕，差分累计支持多圈拖拽；同一帧连发多次 objectChange 时
 *    q_cur 恒反映 TC 全量旋转，差分不丢角度。
 */
export class RotateRings extends Object3D {
  readonly ringRadius: number;
  /** 启用轴掩码（[X, Y, Z]）→ driver attach 的 showX/Y/Z */
  readonly axisMask: [boolean, boolean, boolean];
  /** 视角环（E）开关 → driver attach 的 viewRing */
  readonly viewRing: boolean;
  private joint: Object3D | null = null;
  // 朝向携带：carryParent 世界朝向 × localOffset = proxy 朝向；localOffset 只在设携带/外部拖拽时改写
  private carryParent: Object3D | null = null;
  private readonly localOffset = new Quaternion();
  private dragging = false;
  // 外部拖拽状态：按下快照 + 冻结拖轴 + 逐次累计角
  private dragAxisIndex = -1;
  private readonly prevQuat = new Quaternion();
  private readonly dragAxisWorld = new Vector3();
  private totalDelta = 0;

  /** 增量模式：外部拖拽回调「按下以来的累计角」（axisIndex：0-2；axisWorld 为冻结拖轴，只读勿持有） */
  onDragDelta?: (axisIndex: number, totalAngle: number, axisWorld: Vector3) => void;
  /** 外部拖拽开始（kinds 在此捕获快照——等价旧 onPress 的快照职责；选中上报已由球/标记承担） */
  onDragStart?: (axisIndex: number, axisWorld: Vector3) => void;
  onDragEnd?: () => void;
  /** 增量模式的朝向源：非拖拽时每帧调用，返回值即 proxy 的世界朝向（如按当前姿势计算的肘坐标架） */
  orientationSource?: (out: Quaternion) => void;

  constructor(options: RotateRingsOptions = {}) {
    super();
    this.ringRadius = options.ringRadius ?? DEFAULT_RING_RADIUS;
    const rings = options.rings ?? [0, 1, 2];
    this.axisMask = [rings.includes(0), rings.includes(1), rings.includes(2)];
    this.viewRing = options.viewRing ?? true;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** gizmo 尺寸倍率：相对类默认环半径 */
  get manipulatorSize(): number {
    return this.ringRadius / DEFAULT_RING_RADIUS;
  }

  /** 跟随的关节骨：每帧 update 把 proxy 搬到关节世界位置 */
  setJoint(joint: Object3D): void {
    this.joint = joint;
  }

  /** 朝向携带（FK 语义）：proxy 朝向 = parent 世界朝向 × 局部偏移，父骨转动时端骨相对跟随。
   *  局部偏移取调用瞬间的关节局部四元数（装配期 = rest）；调用即把 proxy 摆到关节当前朝向，
   *  保证装配首解（rig.update(0) 先于首次 update()）CopyTransform 拿到的就是正确朝向 */
  setOrientationCarry(parent: Object3D): void {
    this.carryParent = parent;
    if (!this.joint) return;
    this.localOffset.copy(this.joint.quaternion);
    this.joint.updateWorldMatrix(true, false);
    this.joint.getWorldQuaternion(_q);
    this.writeWorldQuat(_q);
    this.joint.getWorldPosition(_c);
    if (this.parent) this.parent.worldToLocal(_c);
    this.position.copy(_c);
  }

  /** 外部操纵器（TC）拖拽开始。axisIndex：0-2 = 局部轴环；-1 = 视角环 E（仅朝向模式可接受，
   *  增量模式的视角环由 driver 在配置层隐藏，这里防御性忽略） */
  beginExternalDrag(axisIndex: number): void {
    this.dragging = true;
    this.dragAxisIndex = axisIndex;
    this.getWorldQuaternion(this.prevQuat);
    this.totalDelta = 0;
    if (axisIndex < 0) return; // 朝向模式的 E 环：TC 全权改写朝向，无需快照
    this.dragAxisWorld.copy(AXES[axisIndex]!).applyQuaternion(this.prevQuat);
    this.onDragStart?.(axisIndex, this.dragAxisWorld);
  }

  /** TC objectChange 时调用：增量模式提取累计角；朝向模式重捕携带 localOffset */
  updateExternalDrag(): void {
    if (!this.dragging) return;
    if (this.onDragDelta) {
      if (this.dragAxisIndex < 0) return; // 防御：增量模式不认 E/XYZE
      // 逐次 twist 差分累计：dq = q_cur × q_prev⁻¹ 绕冻结拖轴的转角（2·atan2(投影, w)）
      this.getWorldQuaternion(_q);
      _dq.copy(this.prevQuat).invert().premultiply(_q);
      this.prevQuat.copy(_q);
      const a = this.dragAxisWorld;
      const dot = _dq.x * a.x + _dq.y * a.y + _dq.z * a.z;
      this.totalDelta += wrapPi(2 * Math.atan2(dot, _dq.w));
      this.onDragDelta(this.dragAxisIndex, this.totalDelta, a);
      return;
    }
    // 朝向模式：TC 已改写自身朝向；FK 携带重捕局部偏移（父骨朝向拖拽中不变）
    if (this.carryParent) {
      this.getWorldQuaternion(_q);
      this.carryParent.getWorldQuaternion(_pq).invert();
      this.localOffset.copy(_pq.multiply(_q));
    }
  }

  endExternalDrag(): void {
    this.dragging = false;
    this.dragAxisIndex = -1;
    // 增量模式的 proxy 朝向是拖拽的临时产物：松手立即回落朝向源
    if (this.onDragDelta) this.syncOrientation();
    this.onDragEnd?.();
  }

  /** 每帧调用（求解之后）：跟随关节位置；非拖拽时朝向 = 朝向源/携带父骨/关节（按优先级）。
   *  渲染与屏幕恒定大小归 TransformControls gizmo，本类不管 */
  update(): void {
    if (!this.joint) return;
    this.joint.getWorldPosition(_c);
    if (this.parent) this.parent.worldToLocal(_c);
    this.position.copy(_c);
    if (!this.dragging) this.syncOrientation();
  }

  private syncOrientation(): void {
    if (!this.joint) return;
    if (this.orientationSource) {
      this.orientationSource(_q);
      this.writeWorldQuat(_q);
    } else if (this.carryParent) {
      this.carryParent.getWorldQuaternion(_q).multiply(this.localOffset);
      this.writeWorldQuat(_q);
    } else {
      this.joint.getWorldQuaternion(_q);
      this.writeWorldQuat(_q);
    }
  }

  /** 世界四元数 → 父局部写入（挂点即场景顶层时恒等；父有变换时保持世界语义） */
  private writeWorldQuat(worldQ: Quaternion): void {
    if (this.parent) {
      this.parent.getWorldQuaternion(_pq).invert();
      this.quaternion.copy(_pq.multiply(worldQ));
    } else {
      this.quaternion.copy(worldQ);
    }
  }

  /** @deprecated 过渡兼容（attach 路由上线后移除）：显隐不再由本类控制 */
  setVisible(v: boolean): void {
    this.visible = v;
  }

  /** @deprecated 过渡兼容（attach 路由上线后移除）：交互归 TransformControls */
  setInteractive(_v: boolean): void {
    // no-op
  }

  dispose(): void {
    this.dragging = false;
    this.removeFromParent();
  }
}
```

- [ ] **Step 4: kinds 迁移到新 proxy API**

`bone.ts`：
- `new RotateRings(ctx.camera, ctx.dom, { ringRadius: …, dragControl: … })` → `new RotateRings({ ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius })`
- 删 `rings.onPress = () => ctx.select(spec.name);`（选中入口 = 标记球，环不再可点）

`root.ts`：同上（`spec.rotation` 分支）。

`limb.ts`：
- elbowRings：`new RotateRings({ ringRadius: spec.pole?.ringRadius ?? ctx.defaults.ringRadius, rings: [0, 1], viewRing: false })`；`elbowRings.onPress = () => {…}` 整段改为：
  ```ts
  // 拖拽快照（TC mouseDown 时捕获）：累计角 × 拖前前臂 = 累计旋转——同一帧连发多个
  // objectChange、求解器还没跑（骨骼位置未更新）时，逐次读骨骼会丢旋转，快照×累计角恒正确
  elbowRings.onDragStart = () => {
    rollBase = rollAngle;
    midObj.getWorldPosition(_elbow0);
    endObj.getWorldPosition(_fore0).sub(_elbow0);
  };
  ```
  （`ctx.select(`${spec.name}:elbow`)` 从 onDragStart 里删掉——选中入口是 pole 球的 onPress，环被拖说明已选中。）
- `elbowRings.onRotateDrag = …` → `elbowRings.onDragDelta = …`（函数体不变）
- endRotation `rings`：`new RotateRings({ ringRadius: spec.ringRadius ?? ctx.defaults.ringRadius })`；删 `rings.onPress = …`
- shoulderRings：`new RotateRings({ ringRadius: …, viewRing: false })`；`shoulderRings.onPress = () => {…}`（含 pole 偏好快照的大段）→ `shoulderRings.onDragStart = () => {…}`，删掉其中 `ctx.select(`${spec.name}:root`);` 行（选中入口 = shoulderMarker.onPress）；`shoulderRings.onRotateDrag` → `onDragDelta`
- 删 `import { RotateRings }` 处不再用的参数传递即可，类型 import 保留

- [ ] **Step 5: skeleton-controls.test.ts 环拖拽用例改直驱 proxy**

旧模式（`dom.fire('pointerdown', clientFor(camera, 环上点))` + pointermove + pointerup 拖环）全部替换为直驱 helper。在 skeleton-controls.test.ts 顶部加：

```ts
import { Quaternion, Vector3 } from 'three';
import { RotateRings } from '../../src/controls/rotate-rings';

const RING_AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/** 直驱旋转 proxy（等价 TC 行为）：beginExternalDrag → 写世界四元数 → updateExternalDrag → endExternalDrag。
 *  proxy 挂在场景顶层（父恒等），quaternion 即世界四元数 */
function driveRing(rings: RotateRings, axisIndex: number, angle: number, steps = 1): void {
  const start = rings.getWorldQuaternion(new Quaternion());
  const axisWorld = RING_AXES[axisIndex]!.clone().applyQuaternion(start);
  rings.beginExternalDrag(axisIndex);
  for (let i = 1; i <= steps; i++) {
    rings.quaternion.copy(new Quaternion().setFromAxisAngle(axisWorld, (angle * i) / steps).multiply(start));
    rings.updateExternalDrag();
  }
  rings.endExternalDrag();
}
```

逐用例改写（保持断言不变，只换驱动方式；环心/环半径/屏幕投影相关的中间变量删除）：
- 「肘环·bend…」（约 284 行）：`driveRing(h.elbowRings, 1, angle)`
- 「肘环·帧内连发 move 不丢角度…」（约 323 行）：`driveRing(h.elbowRings, 1, Math.PI / 2, 2)` 与单步对照（用例语义保留）
- 「肘环·twist…」（约 362 行）：`driveRing(h.elbowRings, 0, angle)`
- 「根关节环 twist / swing / 直链 twist」（约 457/506/546 行）：`driveRing(h.shoulderRings!, 0|1, angle)`；这些用例原来可能在拖拽前 fire pointerdown 捕获快照——现在快照在 `beginExternalDrag`（driveRing 已含）。注意这些用例需要先 `ctl.select('…:root')` 或 pole 球点选？直驱不需要选中（不测路由），但保持用例原有前置姿势/选择步骤中**不依赖环指针命中**的部分
- 「旋转通道：拖环写 rings 朝向…」（约 860 行）：`driveRing(h.rings!, 轴, 角)`——朝向模式 proxy：`beginExternalDrag` + 写 quaternion + `updateExternalDrag` 后 CopyTransform 下一帧生效（用例原有 `rig.update`/`ctl.update` 调用保留）
- 「旋转通道·相对跟随…」（897）、「root 旋转通道…」（929）、「bone 直接掰骨…」（958）：同上直驱
- 引用 `rings.visible` 的用例（W/E 换班 234、操纵器模式 714、纯旋转出环 1029、肩/髋环 1066）：**本任务不断言变化**（过渡 `setVisible` 仍写 `visible`），Task 5 改断言
- grep 兜底：`grep -n "pickRing\|clientFor\|R \* .*scale" tests/controls/skeleton-controls.test.ts`，残留的环命中辅助全部清理

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(controls): RotateRings 重写为无头朝向 proxy——渲染/交互让位 TransformControls

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: ManipulatorDriver 接口 + TransformControlsDriver 适配器

**Files:**
- Modify: `src/controls/types.ts`（`ManipulatorDriver`、`ManipulatorAttachOptions`）
- Create: `src/controls/transform-controls-driver.ts`
- Create: `tests/controls/transform-controls-driver.test.ts`
- Modify: `tests/controls/test-utils.ts`（dom 桩补 TC 需要的 `style`/`ownerDocument`/`releasePointerCapture`）
- Modify: `tsup.config.ts`（external 改 `/^three/`）

**Interfaces:**
- Produces（Task 5 依赖）：
  ```ts
  // types.ts
  export type { ManipulatorDriver, ManipulatorAttachOptions }
  export interface ManipulatorAttachOptions {
    /** rotate 模式显示的轴环（缺省 [true, true, true]） */
    axes?: [boolean, boolean, boolean];
    /** rotate 模式视角环（TC 'E' 通道），缺省 true */
    viewRing?: boolean;
    /** gizmo 尺寸倍率（相对 TC 默认），缺省 1 */
    size?: number;
  }
  /** 外部操纵器驱动接口：装配器只依赖它；生产实现 = TransformControlsDriver，node 测试传 fake */
  export interface ManipulatorDriver {
    setMode(mode: ManipulatorMode): void;
    attach(target: Object3D | null, options?: ManipulatorAttachOptions): void;
    readonly attachedTo: Object3D | null;
    /** TC mouseDown 翻译：axis = TC 命中通道（'X'|'Y'|'Z'|'E'|'XYZE'|…） */
    onDragStart?: ((info: { axis: string | null }) => void) | null;
    onDragChange?: (() => void) | null;
    onDragEnd?: (() => void) | null;
    dispose(): void;
  }
  // transform-controls-driver.ts
  export class TransformControlsDriver implements ManipulatorDriver {
    /** 底层 TransformControls（嵌入方调 snap 等高级配置用） */
    readonly controls: TransformControls;
    constructor(camera: Camera, scene: Object3D, dom: DragDom, dragControl?: DragControl);
  }
  ```
- dragControl 锁由 driver 内部接（`dragging-changed`），不进接口

- [ ] **Step 1: 写失败测试**

`tests/controls/test-utils.ts` 的 `makeDomStub` 补 TC 需要的成员（加在 stub 对象字面量里）：

```ts
style: {} as Record<string, string>, // TC connect 时写 style.touchAction
ownerDocument: { pointerLockElement: null }, // getPointer 读
releasePointerCapture() {},
```

新建 `tests/controls/transform-controls-driver.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { Object3D } from 'three';
import { TransformControlsDriver } from '../../src/controls/transform-controls-driver';
import { makeCamera, makeDomStub } from './test-utils';

function makeDriver() {
  const scene = new Object3D();
  const dom = makeDomStub();
  const dragControl = { lock: vi.fn(), unlock: vi.fn() };
  const driver = new TransformControlsDriver(makeCamera(), scene, dom, dragControl);
  return { scene, dom, dragControl, driver };
}

describe('TransformControlsDriver', () => {
  it('构造：helper 挂进场景（getHelper shim），XYZE 自由轨球通道移除', () => {
    const { scene, driver } = makeDriver();
    expect(scene.children).toHaveLength(1);
    let xyzCount = 0;
    scene.traverse((o) => { if (o.name === 'XYZE') xyzCount++; });
    expect(xyzCount).toBe(0);
    driver.dispose();
  });

  it('setMode 映射 space：rotate→local、translate→world', () => {
    const { driver } = makeDriver();
    driver.setMode('rotate');
    expect(driver.controls.space).toBe('local');
    driver.setMode('translate');
    expect(driver.controls.space).toBe('world');
    driver.dispose();
  });

  it('attach 选项：axes 子集映射 showX/Y/Z；viewRing:false 移除 E 通道，viewRing:true 恢复', () => {
    const { scene, driver } = makeDriver();
    const target = new Object3D();
    driver.attach(target, { axes: [true, true, false], viewRing: false });
    expect(driver.attachedTo).toBe(target);
    expect(driver.controls.showZ).toBe(false);
    let eCount = 0;
    scene.traverse((o) => { if (o.name === 'E') eCount++; });
    expect(eCount).toBe(0);
    driver.attach(target, { viewRing: true });
    eCount = 0;
    scene.traverse((o) => { if (o.name === 'E') eCount++; });
    expect(eCount).toBeGreaterThan(0);
    driver.attach(null);
    expect(driver.attachedTo).toBeNull();
    driver.dispose();
  });

  it('事件翻译：mouseDown/objectChange/mouseUp → onDragStart({axis})/onDragChange/onDragEnd', () => {
    const { driver } = makeDriver();
    const calls: string[] = [];
    driver.onDragStart = (info) => calls.push(`start:${info.axis}`);
    driver.onDragChange = () => calls.push('change');
    driver.onDragEnd = () => calls.push('end');
    (driver.controls as unknown as { axis: string }).axis = 'X';
    driver.controls.dispatchEvent({ type: 'mouseDown' } as never);
    driver.controls.dispatchEvent({ type: 'objectChange' } as never);
    driver.controls.dispatchEvent({ type: 'mouseUp' } as never);
    expect(calls).toEqual(['start:X', 'change', 'end']);
    driver.dispose();
  });

  it('dragging-changed 接 dragControl 视角锁（成对，重复 true 不叠加）', () => {
    const { driver, dragControl } = makeDriver();
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: true } as never);
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: true } as never);
    expect(dragControl.lock).toHaveBeenCalledTimes(1);
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: false } as never);
    expect(dragControl.unlock).toHaveBeenCalledTimes(1);
    driver.dispose();
  });

  it('dispose：归还视角锁、helper 离场、dom 监听移除', () => {
    const { scene, dom, driver, dragControl } = makeDriver();
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: true } as never);
    const before = dom.listenerCount('pointerdown');
    driver.dispose();
    expect(dragControl.unlock).toHaveBeenCalledTimes(1); // 拖拽中途 dispose 也还锁
    expect(scene.children).toHaveLength(0);
    expect(dom.listenerCount('pointerdown')).toBeLessThan(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/controls/transform-controls-driver.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 types.ts + transform-controls-driver.ts**

types.ts 按 Interfaces 块新增（`ManipulatorMode` 已存在，直接引用）。

`src/controls/transform-controls-driver.ts`：

```ts
import { Camera, Object3D } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { DragControl, DragDom } from './drag-target';
import type { ManipulatorAttachOptions, ManipulatorDriver, ManipulatorMode } from './types';

/** TC rotate gizmo 里体系内没有语义的通道：XYZE = 自由轨球（永久移除） */
const FREE_ROTATE_CHANNEL = 'XYZE';
/** 视角环通道（随 attach 的 viewRing 选项移除/恢复） */
const VIEW_RING_CHANNEL = 'E';

/**
 * TransformControls 适配器：把 three 的 TC 包装成装配器依赖的 ManipulatorDriver 窄接口。
 * 已验证的 TC 内部事实（three r170，r160–r170 事件与 gizmo 命名稳定）——
 *  ① 通道节点（picker/gizmo 视觉/helper 视觉）以轴名命名（'X'/'Y'/'Z'/'E'/'XYZE'），
 *    命中检测 intersectObjectWithRay 尊重 object.visible，但 gizmo 每帧 updateMatrixWorld
 *    会把树内全部 handle 的 visible 重置为 true——所以禁用通道只能 removeFromParent，
 *    不能 visible=false；
 *  ② E（视角环）在 showX/Y/Z 不全 true 时由 TC 自己隐藏，但仍走同一移除/恢复通道处理；
 *  ③ r169 起 TC 是 Controls 基类不再是 Object3D，挂场景用 getHelper()（getHelper shim 兼容旧版）。
 */
export class TransformControlsDriver implements ManipulatorDriver {
  readonly controls: TransformControls;
  private readonly helper: Object3D;
  /** 被移除的通道节点（含原父级，恢复用） */
  private readonly removedChannels = new Map<string, { node: Object3D; parent: Object3D }[]>();
  private readonly dragControl?: DragControl;
  private controlLocked = false;

  onDragStart?: ((info: { axis: string | null }) => void) | null;
  onDragChange?: (() => void) | null;
  onDragEnd?: (() => void) | null;

  constructor(camera: Camera, scene: Object3D, dom: DragDom, dragControl?: DragControl) {
    this.dragControl = dragControl;
    this.controls = new TransformControls(camera, dom as unknown as HTMLElement);
    const withHelper = this.controls as unknown as { getHelper?: () => Object3D };
    // r169+：getHelper() 返回挂场景的 helper；更早版本 TC 本身就是 Object3D
    this.helper = typeof withHelper.getHelper === 'function' ? withHelper.getHelper() : (this.controls as unknown as Object3D);
    scene.add(this.helper);
    this.controls.addEventListener('mouseDown', () => {
      this.onDragStart?.({ axis: this.controls.axis });
    });
    this.controls.addEventListener('objectChange', () => this.onDragChange?.());
    this.controls.addEventListener('mouseUp', () => this.onDragEnd?.());
    this.controls.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value?: boolean }).value === true;
      if (dragging === this.controlLocked) return; // 重复事件不叠加锁
      if (dragging) { this.dragControl?.lock(); this.controlLocked = true; }
      else { this.dragControl?.unlock(); this.controlLocked = false; }
    });
    this.setChannel(FREE_ROTATE_CHANNEL, false);
  }

  get attachedTo(): Object3D | null {
    return (this.controls.object as Object3D | undefined) ?? null;
  }

  setMode(mode: ManipulatorMode): void {
    this.controls.setMode(mode);
    // translate 沿世界轴（旧轴箭头语义）；rotate 绕自身轴（旧环语义：环朝向 = 期望骨骼朝向）
    this.controls.space = mode === 'rotate' ? 'local' : 'world';
  }

  attach(target: Object3D | null, options: ManipulatorAttachOptions = {}): void {
    if (!target) {
      this.controls.detach();
      return;
    }
    this.controls.attach(target);
    this.controls.size = options.size ?? 1;
    const [x, y, z] = options.axes ?? [true, true, true];
    this.controls.showX = x;
    this.controls.showY = y;
    this.controls.showZ = z;
    this.setChannel(VIEW_RING_CHANNEL, options.viewRing ?? true);
  }

  dispose(): void {
    if (this.controlLocked) {
      this.dragControl?.unlock();
      this.controlLocked = false;
    }
    this.controls.dispose();
    this.helper.removeFromParent();
    this.removedChannels.clear();
  }

  /** 按名移除/恢复 helper 子树里的通道节点（picker + gizmo 视觉 + helper 视觉，name 匹配一把抓） */
  private setChannel(name: string, on: boolean): void {
    if (on) {
      const entries = this.removedChannels.get(name);
      if (!entries?.length) return;
      for (const { node, parent } of entries) parent.add(node);
      this.removedChannels.delete(name);
      return;
    }
    const entries: { node: Object3D; parent: Object3D }[] = this.removedChannels.get(name) ?? [];
    this.helper.traverse((o) => {
      if (o.name === name && o.parent && !entries.some((e) => e.node === o)) {
        entries.push({ node: o, parent: o.parent });
      }
    });
    for (const { node } of entries) node.removeFromParent();
    this.removedChannels.set(name, entries);
  }
}
```

注意 `setChannel(name, false)` 在构造时（helper 刚建立、gizmo 已实例化）即可移除 XYZE；TC 的 gizmo/picker 在 `new TransformControls` 时已构建完成，helper traverse 能拿到。

- [ ] **Step 4: tsup external 修复**

`tsup.config.ts`：`external: ['three']` → `external: [/^three/]`（否则 `three/examples/jsm/controls/TransformControls.js` 会被打进 dist）。

- [ ] **Step 5: 全量测试 + 类型检查 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿；`grep -c "TransformControlsGizmo" dist/controls/index.js` 应为 0（TC 没被打包）

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(controls): ManipulatorDriver 接口 + TransformControls 适配器（getHelper shim、通道移除、视角锁）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: SkeletonControls attach 路由

**Files:**
- Modify: `src/controls/types.ts`（`BuiltControl.subMoveTargets`）
- Modify: `src/controls/skeleton-controls.ts`（driver 创建/接线、retargetManipulator、applyView 简化）
- Modify: `src/controls/rotate-rings.ts`（删过渡 `setVisible`/`setInteractive`）
- Modify: `src/controls/kinds/limb.ts`（`subMoveTargets` 注册 pole）
- Modify: `tests/controls/test-utils.ts`（`makeFakeDriver`）
- Test: `tests/controls/skeleton-controls.test.ts`（路由用例；旧显隐断言改 driver 断言）

**Interfaces:**
- Consumes: Task 1/2 的 `ExternalDraggable`、Task 3 的 proxy、Task 4 的 `ManipulatorDriver`
- Produces：
  ```ts
  // types.ts BuiltControl 新增字段
  /** 子选中目标的 move 通道挂载点（如 limb 肘部的 pole 球）：子选中 + move 模式时 attach 给它 */
  readonly subMoveTargets?: { key: string; target: ExternalDraggable }[];
  // SkeletonControlsOptions 新增字段
  /** 外部操纵器驱动（缺省内部构造 TransformControlsDriver；node 测试传 fake） */
  manipulator?: ManipulatorDriver;
  ```

- [ ] **Step 1: test-utils 加 fake driver**

```ts
import type { ManipulatorDriver, ManipulatorAttachOptions } from '../../src/controls/types';
import type { Object3D } from 'three';

/** ManipulatorDriver fake：记录 attach/setMode，可编程派发拖拽事件（等价 TC 行为由用例自己写对象变换） */
export function makeFakeDriver() {
  const driver = {
    mode: null as 'move' | 'rotate' | null,
    attachedTo: null as Object3D | null,
    attachOptions: undefined as ManipulatorAttachOptions | undefined,
    onDragStart: null as ((info: { axis: string | null }) => void) | null,
    onDragChange: null as (() => void) | null,
    onDragEnd: null as (() => void) | null,
    setMode(m: 'move' | 'rotate') { this.mode = m; },
    attach(t: Object3D | null, options?: ManipulatorAttachOptions) {
      this.attachedTo = t;
      this.attachOptions = options;
    },
    dispose() {},
    fireDragStart(axis: string | null) { this.onDragStart?.({ axis }); },
    fireDragChange() { this.onDragChange?.(); },
    fireDragEnd() { this.onDragEnd?.(); },
  };
  return driver as ManipulatorDriver & typeof driver;
}
```

注意：接口里 `setMode(mode: ManipulatorMode)`（'move'|'rotate'），fake 的字段类型用 `'move' | 'rotate'`。driver 语义上 translate↔move、rotate↔rotate 的映射在真实 driver 里——**决策**：`ManipulatorDriver.setMode` 直接收 `ManipulatorMode`（'move'|'rotate'），`TransformControlsDriver.setMode` 内部映射到 TC 的 'translate'|'rotate'。修正 Task 4 实现：

```ts
setMode(mode: ManipulatorMode): void {
  this.controls.setMode(mode === 'rotate' ? 'rotate' : 'translate');
  this.controls.space = mode === 'rotate' ? 'local' : 'world';
}
```

Task 4 测试相应断言 `driver.controls.space`（已如此），`driver.setMode('rotate')` 后 `controls.mode === 'rotate'` 可加断言。

- [ ] **Step 2: 写失败测试（路由表）**

skeleton-controls.test.ts 顶部 import fake；该文件构造 SkeletonControls 的 helper 全部补传 `manipulator: makeFakeDriver()`（先 grep 构造点，统一改）。新增 describe：

```ts
describe('attach 路由（fake driver）', () => {
  // 复用文件内既有 rig/controls 搭建 helper（makeXxx 按文件现状命名），断言 driver 状态

  it('move 模式选中双通道主名 → translate attach 端球；切 rotate → rotate attach 端骨环', () => {
    // legL: kind 'limb' + endRotation: true
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('腿L');
    expect(driver.mode).toBe('move');
    expect(driver.attachedTo).toBe(handles.legL.target);
    ctl.setManipulatorMode('rotate');
    expect(driver.mode).toBe('rotate');
    expect(driver.attachedTo).toBe(handles.legL.rings);
  });

  it('纯位置控制点（chain）两种模式都 attach translate', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.select('脊柱'); // chain
    expect(driver.mode).toBe('move');
    expect(driver.attachedTo).toBe(handles.spine.target);
    ctl.setManipulatorMode('rotate');
    expect(driver.mode).toBe('rotate'); // 全局模式照切
    expect(driver.attachedTo).toBe(handles.spine.target); // 但 attach 的仍是平移通道
    // driver 收到的 setMode 是装配器模式；纯位置在 rotate 下 attach 时 mode 参数仍为 translate：
  });

  it('纯旋转控制点（bone，rotationOnly）W 模式选中也 attach rotate', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('胸口'); // bone
    expect(driver.attachedTo).toBe(handles.chest.rings);
  });

  it('子选中 elbow：W → translate attach pole.ball（axes 默认）；E → rotate attach 肘环（showZ=false, viewRing=false）', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('腿L:elbow');
    expect(driver.attachedTo).toBe(handles.legL.pole.ball);
    ctl.setManipulatorMode('rotate');
    expect(driver.attachedTo).toBe(handles.legL.elbowRings);
    expect(driver.attachOptions?.axes).toEqual([true, true, false]);
    expect(driver.attachOptions?.viewRing).toBe(false);
  });

  it('子选中 root（肩/髋，rotationOnly）：两种模式都 rotate attach 肩/髋环', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.setManipulatorMode('move');
    ctl.select('腿L:root');
    expect(driver.attachedTo).toBe(handles.legL.shoulderRings);
  });

  it('取消选中 detach；移除控制点时若 attach 在其对象上先 detach', () => {
    const { ctl, driver } = setupWithDriver();
    ctl.select('腿L');
    expect(driver.attachedTo).not.toBeNull();
    ctl.select(null);
    expect(driver.attachedTo).toBeNull();
    ctl.select('腿L');
    ctl.remove('腿L');
    expect(driver.attachedTo).toBeNull();
  });

  it('TC 拖拽平移经 reclamp：外部直写位置过钳制回写；endExternalDrag 恢复携带', () => {
    const { ctl, driver, handles } = setupWithDriver();
    ctl.select('脊柱'); // chain，可达钳制生效（首解后）
    const t = handles.spine.target;
    driver.fireDragStart('X');
    expect(t.isDragging).toBe(true);
    t.position.set(99, 0, 0); // 模拟 TC 直写
    driver.fireDragChange();
    expect(t.position.length()).toBeLessThanOrEqual(handles.spine.reach + 1e-6);
    driver.fireDragEnd();
    expect(t.isDragging).toBe(false);
  });

  it('TC 拖拽旋转增量：rotate 模式肘环 fireDragStart("Y") → 快照捕获、fireDragChange 提取累计角', () => {
    const { ctl, driver, handles, rig } = setupWithDriver();
    ctl.setManipulatorMode('rotate');
    ctl.select('腿L:elbow');
    driver.fireDragStart('Y');
    // 模拟 TC 写入：绕肘环 Y 轴转 30°
    const rings = handles.legL.elbowRings;
    const start = rings.getWorldQuaternion(new Quaternion());
    const axisWorld = new Vector3(0, 1, 0).applyQuaternion(start);
    rings.quaternion.copy(new Quaternion().setFromAxisAngle(axisWorld, Math.PI / 6).multiply(start));
    driver.fireDragChange();
    driver.fireDragEnd();
    rig.update(0.016);
    ctl.update();
    // 脚绕膝画弧：脚位置变了、膝位置不动（bend 语义；具体断言复用「肘环·bend」用例的写法）
  });

  it('driver onDragStart 置 pressClaimed：拖拽开始的 pointerdown 不触发空白失焦', () => {
    const { ctl, driver, dom } = setupWithDriver();
    ctl.select('腿L');
    driver.fireDragStart('X');
    dom.fire('pointerdown', {}); // 同一轮按下（真实环境 TC 的 dom 监听先跑）
    dom.fire('pointerup', {});
    expect(ctl.getSelected()).toBe('腿L');
  });
});
```

同时把 Task 3 标注的旧显隐断言用例改为 driver 断言：
- 「肘部操纵器 W/E 换班」（234）：pole 球 marker 模式断言保留（球显隐不归 driver）；「肘环上场」断言改为 `driver.attachedTo === handles.elbowRings`（E+子选中肘部后）/ `null`（未选中）
- 「操纵器模式」（714）：球↔环切换断言改 driver.attachedTo
- 「纯旋转控制点选中即出环不看 W/E」（1029）：`driver.attachedTo === chest.rings`（两种模式）
- 「肩/髋根环 W 模式选中即出环」（1066）：`driver.attachedTo === shoulderRings`

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/controls/skeleton-controls.test.ts`
Expected: FAIL——options.manipulator 未接线 / subMoveTargets 不存在

- [ ] **Step 4: 实现**

types.ts：`BuiltControl` 加 `subMoveTargets` 字段（见 Interfaces）。

skeleton-controls.ts：

1. import：`TransformControlsDriver`、`ManipulatorDriver`、`ExternalDraggable`、`RotateRings`（类型）。
2. 新字段：
   ```ts
   private readonly driver: ManipulatorDriver;
   /** 当前 attach 的操控对象（事件分派用） */
   private currentManipulator: { draggable: ExternalDraggable; proxy?: undefined } | { proxy: RotateRings; draggable?: undefined } | null = null;
   ```
3. 构造器：`buildControl` 循环**之前**创建 driver（TC 的 dom 指针监听要先于控制点操纵器注册，保证 pressClaimed 时序）：
   ```ts
   this.driver = options.manipulator ?? new TransformControlsDriver(options.camera, options.scene, options.dom, options.dragControl);
   this.driver.onDragStart = ({ axis }) => this.onManipulatorDragStart(axis);
   this.driver.onDragChange = () => this.onManipulatorDragChange();
   this.driver.onDragEnd = () => this.onManipulatorDragEnd();
   ```
4. 事件分派：
   ```ts
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
   ```
5. attach 路由（核心）：
   ```ts
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
   ```
6. `select()` 与 `setManipulatorMode()` 末尾（applyView 循环之后）调 `this.retargetManipulator()`；`buildControl` 末尾 applyView 后不需要（新控制点不会被选中）。`remove(name)`：若 `currentManipulator` 属于被删控制点（粗判：`this.selectedName` 已被清空前处理）——在 `remove` 开头：
   ```ts
   if (this.selectedName === name || this.selectedName?.startsWith(name + ':')) this.select(null); // 内部会 retarget detach
   ```
   （替换现有的 `this.selectedName = null` 直写。）
7. applyView 简化：删 `rotateRings`/`subRingGroups` 的 setVisible/setInteractive 循环（约 232-244 行）；`c.onModeChange`/`c.onSelectionChange` 保留；`t.setSelected(move && selected)` 改 `t.setSelected(selected)`（setSelected 现在只管 marker 高亮）。
8. rotate-rings.ts：删过渡 `setVisible`/`setInteractive` 方法；grep 全库确认无调用方残留。
9. `dispose()`：`this.driver.dispose();` 加在清场逻辑里。
10. limb.ts：`BuiltControl` 返回对象加 `subMoveTargets: [{ key: 'elbow', target: pole }]`（pole 是 PoleOrbit，已实现 ExternalDraggable）。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(controls): 装配器 attach 路由——选中态 × W/E 决定 TransformControls 挂点

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 可配置快捷键 + playground 接入

**Files:**
- Modify: `src/controls/types.ts`（`HotkeyMap`/`HotkeyEvent`/`HotkeyTarget`）
- Modify: `src/controls/skeleton-controls.ts`（hotkeys 选项、`setHotkeys`、`onManipulatorModeChange` 回调）
- Modify: `playground/src/tab-ik.ts`（删自有 keydown，改用内置 + 回调同步 GUI）
- Test: `tests/controls/skeleton-controls.test.ts`

**Interfaces:**
- Produces：
  ```ts
  // types.ts
  export interface HotkeyMap {
    /** 切 move 模式，默认 'w'；数组 = 一个动作绑多键（如 ['w', '1']）；空数组 = 禁用该动作 */
    move?: string | string[];
    /** 切 rotate 模式，默认 'e' */
    rotate?: string | string[];
    /** 取消选中，默认 'Escape' */
    deselect?: string | string[];
  }
  /** 键盘事件最小结构（库不依赖 DOM lib；与 KeyboardEvent 字段子集兼容） */
  export interface HotkeyEvent { key: string; repeat: boolean; target: unknown; }
  export interface HotkeyTarget {
    addEventListener(type: 'keydown', listener: (e: HotkeyEvent) => void): void;
    removeEventListener(type: 'keydown', listener: (e: HotkeyEvent) => void): void;
  }
  // SkeletonControlsOptions 新增
  /** 快捷键表；false = 关闭内置监听（宿主用 setManipulatorMode/select(null) 自绑）。缺省 = 默认表 */
  hotkeys?: HotkeyMap | false;
  /** 键盘事件宿主（缺省 window 若存在；node 测试传桩；嵌入方限定监听范围走这里） */
  hotkeyTarget?: HotkeyTarget;
  /** 模式变化回调（快捷键/GUI 任一入口切换都触发； playground 用它同步 GUI 下拉框） */
  onManipulatorModeChange?: (mode: ManipulatorMode) => void;
  // SkeletonControls 新增方法
  setHotkeys(map: HotkeyMap | false): void;
  ```

- [ ] **Step 1: 写失败测试**

```ts
describe('快捷键', () => {
  function makeKeyTarget() {
    const listeners: Array<(e: HotkeyEvent) => void> = [];
    return {
      addEventListener(_t: 'keydown', l: (e: HotkeyEvent) => void) { listeners.push(l); },
      removeEventListener(_t: 'keydown', l: (e: HotkeyEvent) => void) {
        const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1);
      },
      fire(e: Partial<HotkeyEvent> & { key: string }) {
        for (const l of [...listeners]) l({ repeat: false, target: null, ...e });
      },
      count: () => listeners.length,
    };
  }

  it('默认表：w/e 切模式（大小写不敏感）、Escape 取消选中；模式回调触发', () => {
    const keyTarget = makeKeyTarget();
    const modes: string[] = [];
    const { ctl } = setupWithDriver({ hotkeyTarget: keyTarget, onManipulatorModeChange: (m) => modes.push(m) });
    ctl.select('腿L');
    keyTarget.fire({ key: 'E' });
    expect(ctl.getManipulatorMode()).toBe('rotate');
    keyTarget.fire({ key: 'w' });
    expect(ctl.getManipulatorMode()).toBe('move');
    expect(modes).toEqual(['rotate', 'move']);
    keyTarget.fire({ key: 'Escape' });
    expect(ctl.getSelected()).toBeNull();
  });

  it('自定义表与数组多绑；hotkeys:false 不监听；setHotkeys 运行期换绑/关闭', () => {
    const keyTarget = makeKeyTarget();
    const { ctl } = setupWithDriver({ hotkeyTarget: keyTarget, hotkeys: { move: ['q', '1'], rotate: 'r' } });
    keyTarget.fire({ key: 'w' });
    expect(ctl.getManipulatorMode()).toBe('move'); // 默认 w 已失效（还是 move 不变）
    keyTarget.fire({ key: 'r' });
    expect(ctl.getManipulatorMode()).toBe('rotate');
    keyTarget.fire({ key: '1' });
    expect(ctl.getManipulatorMode()).toBe('move');
    ctl.setHotkeys(false);
    keyTarget.fire({ key: 'r' });
    expect(ctl.getManipulatorMode()).toBe('move');
    ctl.setHotkeys({ rotate: 'e' });
    keyTarget.fire({ key: 'e' });
    expect(ctl.getManipulatorMode()).toBe('rotate');
  });

  it('repeat 与可编辑元素事件源不响应；dispose 解绑', () => {
    const keyTarget = makeKeyTarget();
    const { ctl } = setupWithDriver({ hotkeyTarget: keyTarget });
    keyTarget.fire({ key: 'e', repeat: true });
    expect(ctl.getManipulatorMode()).toBe('move');
    keyTarget.fire({ key: 'e', target: { tagName: 'INPUT' } });
    expect(ctl.getManipulatorMode()).toBe('move');
    keyTarget.fire({ key: 'e', target: { tagName: 'TEXTAREA' } });
    expect(ctl.getManipulatorMode()).toBe('move');
    keyTarget.fire({ key: 'e', target: { isContentEditable: true } });
    expect(ctl.getManipulatorMode()).toBe('move');
    keyTarget.fire({ key: 'e' });
    expect(ctl.getManipulatorMode()).toBe('rotate');
    ctl.dispose();
    expect(keyTarget.count()).toBe(0);
  });
});
```

（`setupWithDriver(options)` 是在 Task 5 的构造 helper 上扩展透传 options——实现时按文件现状调整。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/controls/skeleton-controls.test.ts`
Expected: FAIL——hotkeyTarget/hotkeys 选项未实现

- [ ] **Step 3: 实现**

types.ts 按 Interfaces 新增。

skeleton-controls.ts：

```ts
const DEFAULT_HOTKEYS: Required<HotkeyMap> = { move: ['w'], rotate: ['e'], deselect: ['Escape'] };

// 类新字段：
private readonly hotkeyTargetOption?: HotkeyTarget;
private hotkeyTarget: HotkeyTarget | null = null;
private hotkeyListener: ((e: HotkeyEvent) => void) | null = null;
private readonly onModeChangeCallback?: (mode: ManipulatorMode) => void;
```

构造器存 `options.hotkeyTarget`/`options.onManipulatorModeChange`，末尾调 `this.setHotkeys(options.hotkeys ?? DEFAULT_HOTKEYS)`。

```ts
/** 快捷键绑定：map = 换绑（字段缺省回落默认表），false = 关闭。dispose 自动解绑 */
setHotkeys(map: HotkeyMap | false): void {
  this.unbindHotkeys();
  if (map === false) return;
  const target = this.hotkeyTargetOption
    ?? (typeof window !== 'undefined' ? (window as unknown as HotkeyTarget) : undefined);
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
```

`setManipulatorMode` 末尾（模式确实变化的分支里）加 `this.onModeChangeCallback?.(mode);`；`dispose()` 加 `this.unbindHotkeys();`。

模块底部（`toVec3` 附近的工具函数区，放 types.ts 或本文件私有均可——放本文件私有）：

```ts
function toKeyArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}
```

playground `tab-ik.ts`：
- 删 `onKeyHandler`/`onKey`/`window.addEventListener('keydown', …)` 与 unmount 里的移除（约 144-151 行与 197 行附近）
- `createSkeletonControls` 调用处加：`onManipulatorModeChange: (m) => { params.manipulatorMode = m; modeCtrl?.updateDisplay(); }`（注意 `modeCtrl` 声明顺序——`params`/`modeCtrl` 需提到 ctl 创建之前可引用处；若构造在 GUI 之前，用 `let modeCtrl` 已有的声明即可，回调闭包延迟到按键时执行）
- `applyMode` 保留给 GUI 下拉框用（内部仍调 `ctl.setManipulatorMode`——回调会让 GUI 自同步一次，幂等无副作用）

- [ ] **Step 4: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(controls): 可配置快捷键——hotkeys 选项收编 W/E/Escape，支持运行期换绑与关闭

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 导出、README、全量验证

**Files:**
- Modify: `src/controls/index.ts`
- Modify: `README.md`
- Modify: `tests/public-api.test.ts`（若覆盖 controls 入口则同步）

- [ ] **Step 1: 补导出**

`src/controls/index.ts` 追加：

```ts
export { TransformControlsDriver } from './transform-controls-driver';
export type { ManipulatorDriver, ManipulatorAttachOptions, ExternalDraggable, HotkeyMap, HotkeyEvent, HotkeyTarget } from './types';
export { DEFAULT_BALL_RADIUS } from './drag-target';
export { DEFAULT_RING_RADIUS } from './rotate-rings';
```

检查 `tests/public-api.test.ts` 是否断言 controls 入口（当前只查 src/index——若如此则不用改；给 controls 入口加一条 import 冒烟断言亦可，非必须）。

- [ ] **Step 2: README 更新**

找到操纵器/接入指南相关段落（grep `setAxisHandles\|RotateRings\|轴箭头\|旋转环\|W/E` README.md），更新：
- 「轴箭头/旋转环」表述改为「移动/旋转操纵器由 three TransformControls 提供」
- 新增快捷键段落：`hotkeys`/`hotkeyTarget`/`setHotkeys` 用法 + `hotkeys: false` 自绑出口
- Breaking 说明（0.0.x）：`DragTarget.setAxisHandles`/`PoleOrbit.setAxisHandles` 删除；`RotateRings` 构造签名变化（不再收 camera/dom），渲染相关方法（`setInteractive`/`setVisible`/`depthUniforms`）删除；`onRotateDrag` 改名 `onDragDelta`，快照捕获从 `onPress` 挪 `onDragStart`

- [ ] **Step 3: 全量验证**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿

- [ ] **Step 4: playground 实测（人工或 playwright）**

`npm run playground` 起 vite，验证清单：
1. 点击脚/手球 → TC 移动箭头出现；拖 X 箭头单轴移动；超可达半径被钳回
2. W → E 切换：端球变标记、attach 切到环；拖环转端骨朝向
3. 点 pole 球选中肘部：W = TC 移动 gizmo 在 pole 球上，拖动分解朝向+弯度；E = 肘部两环（无 Z 环、无视角环），拖 X = 扭转、拖 Y = 伸缩
4. 点肩/髋标记球：三维环上场扭转/摆动
5. 点空白失焦、gizmo 收起；拖动视角不误触失焦
6. Escape 取消选中；GUI 下拉框随键盘切换同步

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: TransformControls 换芯收尾——controls 入口导出 + README 接入指南更新

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 接口/适配器 → Task 4；§2 DragTarget/PoleOrbit → Task 1/2；§3 proxy → Task 3；§4 路由 → Task 5；§5 API → Task 1/3/5/7；§6 测试/playground → 各 Task + Task 7；§7 快捷键 → Task 6。getHelper shim → Task 4。tsup external 是侦察中新发现（spec 未列），已纳入 Task 4。
- **已知取舍**（与 spec 一致）：增量模式拖拽中环跟手转；scale 不接；首击 = 选中+自由拖（DragTarget 自身平面拖保留），TC 在选中后接管。
- **类型一致性**：`ExternalDraggable`（Task 1）= Task 2/5 消费签名一致；`ManipulatorDriver.setMode(ManipulatorMode)`（Task 4 定义、Task 5 修正为收 'move'|'rotate' 并在 driver 内映射 TC 的 'translate'）——executor 注意 Task 5 Step 1 的修正说明；proxy 钩子 `onDragStart/onDragDelta/onDragEnd` 与 `beginExternalDrag/updateExternalDrag/endExternalDrag` 在 Task 3/5 间签名一致。
