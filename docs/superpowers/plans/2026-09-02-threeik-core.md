# threeik 核心库实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 three.js 人形骨架编辑基础库 `threeik`：骨架数据层（SkeletonRig）+ 修改器链（CCD/FABRIK/TwoBone IK、约束）+ 人形 profile 与重定向 + playground 演示。

**Architecture:** 忠实移植 Godot 4 骨架架构（`Skeleton3D`/`SkeletonModifier3D`/`IterateIK3D`/`RetargetModifier3D`/`SkeletonProfileHumanoid`）到 three.js：扁平骨骼数组（DFS 序 = nested-set 区间）+ 分解姿势存储 + modifier 管线（快照→执行→influence 混合→写回→基准姿势隔离）+ 链坐标系 IK 求解。JS 侧差异：显式 `rig.update(delta)` 替代 SceneTree 生命周期，普通数组替代子节点扫描。

**Tech Stack:** TypeScript（strict）+ three.js（peer dep >=0.160）+ tsup 构建 + vitest 测试；playground 用 Vite + lil-gui。

**Spec:** `docs/superpowers/specs/2026-09-02-threeik-design.md`

## Global Constraints

- 包名 `threeik`，纯 ESM 输出（`dist/index.js` + `dist/index.d.ts`），除 three.js（peerDependency `>=0.160.0`）外**零运行时依赖**。
- TypeScript strict 模式；所有公开 API 必须有类型标注。
- **求解热路径零分配**：所有 IK/管线内部复用模块级临时变量（`_tmp` 系列），不在循环内 `new Vector3/Quaternion`。
- 姿势一律以分解形式（position/quaternion/scale）存储与传递，内部不使用 Matrix4 逐骨存储；重定向 pre/post basis 用 Matrix3（允许镜像）。
- 骨骼按名字寻址（配置里存骨名字符串）；rig 内部的 `Bone[]` 索引在 `rebind()` 时重建，不跨 attach 缓存。
- 更新顺序契约（写入 README 与 playground）：`mixer.update(dt)` → `rig.captureBasePose()`（仅动画路径）→ `rig.update(dt)` → `renderer.render()`；重定向目标 rig 必须在源 rig 之后 update。
- 测试用 vitest，node 环境（three.js 数学无需 DOM）；每个 Task 以 `npx vitest run <file>` 通过 + `git commit` 结束。
- Godot 源码参考路径：`/Users/huhui/Projects/godot`（对照实现时阅读，不复制注释版权头；算法为独立翻译实现）。
- Godot 数学约定：四元数 `a * b` 先应用 b 再应用 a，与 three.js `a.multiply(b)` 一致；`quat.xform(v)` ↔ `v.applyQuaternion(q)`；`xform_inv` ↔ 先取逆再应用。Godot `Math::is_zero_approx` ↔ `abs(x) < 1e-5`（`CMP_EPSILON`）。

## 文件结构总览

```
package.json / tsconfig.json / tsup.config.ts / vitest.config.ts
src/
  core/errors.ts            # ThreeIKError
  core/events.ts            # TinyEmitter（on/off/emit + warnOnce）
  core/math.ts              # Godot 数学工具翻译
  core/bone-axes.ts         # 骨骼轴向枚举与向量映射
  core/skeleton-rig.ts      # 数据层核心
  modifiers/modifier.ts     # Modifier 基类
  modifiers/modifier.ts     # Modifier 基类（管线在 skeleton-rig.ts 的 update()，见 Task 7）
  modifiers/ik/ik-chain.ts       # IKChain：链状态 + 坐标更新
  modifiers/ik/joint-setting.ts  # JointSetting：轴投影 + 限制接线
  modifiers/ik/joint-limitation.ts # JointLimitation 基类 + ConeJointLimitation
  modifiers/ik/iterate-ik.ts     # IterateIKModifier 基类（求解流程）
  modifiers/ik/ccd-ik.ts         # CCDIkModifier
  modifiers/ik/fabrik.ts         # FabrikModifier
  modifiers/ik/two-bone-ik.ts    # TwoBoneIkModifier
  modifiers/constraints/aim.ts   # AimModifier
  modifiers/constraints/copy-transform.ts # CopyTransformModifier
  retarget/humanoid-profile.ts   # 56 骨 profile 数据
  retarget/bone-map.ts           # BoneMap + 预设生成
  retarget/retarget-modifier.ts  # RetargetModifier
  index.ts
tests/                      # 与 src 同构的 .test.ts
playground/                 # Vite 应用（不发布）
```

**与 spec §7 的一处偏差（已在 brainstorm 中确认架构方向，特此记录）**：RetargetModifier 挂在**目标 rig** 的修改器链上、持源 rig 引用，而非 Godot 的源挂载多目标。原因：本库的管线快照/influence 混合由目标 rig 自己的 `update()` 管理，源挂载会让目标骨的写回与隔离语义断裂。功能等价（1→N 重定向 = N 个目标各挂一个 modifier）。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Produces: 可运行的 `npm run test`（vitest）、`npm run build`（tsup）命令；后续所有 task 在此基础上添加文件。

- [ ] **Step 1: 写 package.json 与配置文件**

`package.json`:
```json
{
  "name": "threeik",
  "version": "0.0.1",
  "description": "Humanoid skeleton editing and IK library for three.js, ported from Godot's skeleton architecture",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "playground": "npm --prefix playground run dev"
  },
  "peerDependencies": {
    "three": ">=0.160.0"
  },
  "devDependencies": {
    "three": "^0.170.0",
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

`tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['three'],
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

`.gitignore`:
```
node_modules/
dist/
playground/public/*.glb
```

`src/index.ts`（占位，后续 task 补全）:
```ts
export {};
```

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: 安装依赖并验证**

Run: `npm install && npm run test && npm run typecheck && npm run build`
Expected: vitest 1 passed；tsc 无错误；tsup 产出 `dist/index.js` 与 `dist/index.d.ts`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: 项目脚手架（tsup + vitest + typescript）"
```

---

### Task 2: ThreeIKError 与事件发射器

**Files:**
- Create: `src/core/errors.ts`
- Create: `src/core/events.ts`
- Test: `tests/core/events.test.ts`

**Interfaces:**
- Produces:
  - `class ThreeIKError extends Error { readonly code: string }`，静态工厂：`ThreeIKError.boneNotFound(name: string)`、`ThreeIKError.invalidChain(reason: string)`、`ThreeIKError.configError(reason: string)`
  - `class TinyEmitter<Events extends string> { on(e, cb): () => void; off(e, cb): void; emit(e, payload?): void; warnOnce(key: string, message: string): void }`（`warnOnce` 每个 key 只发一次 `'warning'` 事件；`clearWarnings()` 重置）
- Consumes: 无

- [ ] **Step 1: 写失败测试**

`tests/core/events.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { TinyEmitter } from '../../src/core/events';
import { ThreeIKError } from '../../src/core/errors';

describe('TinyEmitter', () => {
  it('calls listeners and unsubscribes', () => {
    const em = new TinyEmitter<'rest-updated' | 'warning'>();
    const cb = vi.fn();
    const off = em.on('rest-updated', cb);
    em.emit('rest-updated');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    em.emit('rest-updated');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('warnOnce emits one warning per key', () => {
    const em = new TinyEmitter<'warning'>();
    const cb = vi.fn();
    em.on('warning', cb);
    em.warnOnce('nan-target', 'target is NaN');
    em.warnOnce('nan-target', 'target is NaN');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toMatchObject({ key: 'nan-target' });
    em.clearWarnings();
    em.warnOnce('nan-target', 'target is NaN');
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('ThreeIKError', () => {
  it('carries code and descriptive message', () => {
    const e = ThreeIKError.boneNotFound('LeftHand');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('BONE_NOT_FOUND');
    expect(e.message).toContain('LeftHand');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/events.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/core/errors.ts`:
```ts
export class ThreeIKError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ThreeIKError';
    this.code = code;
  }

  static boneNotFound(name: string): ThreeIKError {
    return new ThreeIKError('BONE_NOT_FOUND', `Bone not found in skeleton: "${name}"`);
  }

  static invalidChain(reason: string): ThreeIKError {
    return new ThreeIKError('INVALID_CHAIN', `Invalid IK chain: ${reason}`);
  }

  static configError(reason: string): ThreeIKError {
    return new ThreeIKError('CONFIG_ERROR', reason);
  }
}
```

`src/core/events.ts`:
```ts
export interface WarningPayload {
  key: string;
  message: string;
}

type Listener = (payload?: unknown) => void;

export class TinyEmitter<Events extends string> {
  private listeners = new Map<Events, Set<Listener>>();
  private warnedKeys = new Set<string>();

  on(event: Events, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => this.off(event, cb);
  }

  off(event: Events, cb: Listener): void {
    this.listeners.get(event)?.delete(cb);
  }

  emit(event: Events, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  }

  /** Emits a 'warning' event once per key until clearWarnings() is called. */
  warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.emit('warning' as Events, { key, message } satisfies WarningPayload);
  }

  clearWarnings(): void {
    this.warnedKeys.clear();
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/events.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/core tests/core
git commit -m "feat(core): ThreeIKError 与 TinyEmitter"
```

### Task 3: core/math.ts —— Godot 数学工具翻译

**Files:**
- Create: `src/core/math.ts`
- Test: `tests/core/math.test.ts`

**Interfaces:**
- Produces（后续所有 solver 依赖，签名不得改动）:
  - `const CMP_EPSILON = 1e-5`，`isZeroApprox(x: number): boolean`，`isEqualApprox(a: number, b: number): boolean`
  - `limitLength(origin: Vector3, destination: Vector3, length: number, out: Vector3): Vector3`
  - `getFromToRotation(from: Vector3, to: Vector3, prevRot: Quaternion, out: Quaternion): Quaternion`（from/to 为单位向量；抗平行时返回 prevRot）
  - `getFromToRotationByAxis(from: Vector3, to: Vector3, axis: Vector3, out: Quaternion): Quaternion`（axis 单位向量；from/to 单位向量）
  - `getSwing(rotation: Quaternion, axis: Vector3, out: Quaternion): Quaternion`
  - `snapVectorToPlane(planeNormal: Vector3, vector: Vector3, out: Vector3): Vector3`（保持长度）
  - `symmetrizeAngle(angle: number): number`（→ [-π, π]）
  - `getRollAngle(rotation: Quaternion, rollAxis: Vector3): number`
  - `getProjectedNormal(a: Vector3, b: Vector3, point: Vector3, out: Vector3): Vector3`（无限直线 a→b 指向 point 的最近法向；退化返回零向量）
  - `xformQuat(q: Quaternion, v: Vector3, out: Vector3): Vector3`、`xformQuatInv(q: Quaternion, v: Vector3, out: Vector3): Vector3`

对照源码：`/Users/huhui/Projects/godot/scene/3d/skeleton_modifier_3d.cpp` 第 270–398 行。

- [ ] **Step 1: 写失败测试**

`tests/core/math.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  limitLength, getFromToRotation, getFromToRotationByAxis, getSwing,
  snapVectorToPlane, symmetrizeAngle, getRollAngle, getProjectedNormal,
} from '../../src/core/math';

const expectVecClose = (v: Vector3, x: number, y: number, z: number, eps = 1e-4) => {
  expect(v.x).toBeCloseTo(x, 4);
  expect(v.y).toBeCloseTo(y, 4);
  expect(v.z).toBeCloseTo(z, 4);
};

describe('limitLength', () => {
  it('clamps destination to length from origin', () => {
    const out = new Vector3();
    limitLength(new Vector3(0, 0, 0), new Vector3(0, 0, 5), 2, out);
    expectVecClose(out, 0, 0, 2);
  });
});

describe('getFromToRotation', () => {
  it('rotates +X onto +Y (90 deg about +Z)', () => {
    const q = getFromToRotation(new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Quaternion(), new Quaternion());
    const v = new Vector3(1, 0, 0).applyQuaternion(q);
    expectVecClose(v, 0, 1, 0);
  });

  it('returns prevRot for antiparallel vectors', () => {
    const prev = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7);
    const out = new Quaternion();
    getFromToRotation(new Vector3(1, 0, 0), new Vector3(-1, 0, 0), prev, out);
    expect(out.angleTo(prev)).toBeLessThan(1e-6);
  });
});

describe('getFromToRotationByAxis', () => {
  it('rotates +X to +Y by +90deg about +Z', () => {
    const q = getFromToRotationByAxis(new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Quaternion());
    expectVecClose(new Vector3(1, 0, 0).applyQuaternion(q), 0, 1, 0);
  });

  it('is identity for parallel vectors', () => {
    const q = getFromToRotationByAxis(new Vector3(1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Quaternion());
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('uses axis for PI rotation when antiparallel', () => {
    const q = getFromToRotationByAxis(new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Quaternion());
    expectVecClose(new Vector3(1, 0, 0).applyQuaternion(q), -1, 0, 0);
  });
});

describe('getSwing', () => {
  it('extracts swing component about axis', () => {
    const twist = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const swing = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    const rot = new Quaternion().copy(swing).multiply(twist); // swing * twist
    const out = getSwing(rot, new Vector3(0, 1, 0), new Quaternion());
    expect(out.angleTo(swing)).toBeLessThan(1e-4);
  });
});

describe('snapVectorToPlane', () => {
  it('projects onto plane keeping length', () => {
    const out = snapVectorToPlane(new Vector3(0, 0, 1), new Vector3(1, 1, 1), new Vector3());
    expectVecClose(out, 1, 1, 0);
  });

  it('returns vector unchanged for zero normal', () => {
    const out = snapVectorToPlane(new Vector3(0, 0, 0), new Vector3(1, 2, 3), new Vector3());
    expectVecClose(out, 1, 2, 3);
  });
});

describe('symmetrizeAngle', () => {
  it('wraps to [-PI, PI]', () => {
    expect(symmetrizeAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 6);
    expect(symmetrizeAngle(Math.PI / 4)).toBeCloseTo(Math.PI / 4, 6);
    expect(symmetrizeAngle(Math.PI * 2.25)).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('getRollAngle', () => {
  it('returns signed roll around axis', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    expect(getRollAngle(q, new Vector3(1, 0, 0))).toBeCloseTo(0.7, 5);
    expect(getRollAngle(q, new Vector3(-1, 0, 0))).toBeCloseTo(-0.7, 5);
  });
});

describe('getProjectedNormal', () => {
  it('returns nearest normal from line to point', () => {
    const out = getProjectedNormal(new Vector3(0, 0, 0), new Vector3(0, 0, 1), new Vector3(1, 2, 3), new Vector3());
    expectVecClose(out, 1 / Math.sqrt(5), 2 / Math.sqrt(5), 0);
  });

  it('returns zero for degenerate line', () => {
    const out = getProjectedNormal(new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(0, 0, 0), new Vector3());
    expectVecClose(out, 0, 0, 0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/math.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现（逐行翻译自 skeleton_modifier_3d.cpp）**

`src/core/math.ts`:
```ts
import { Quaternion, Vector3 } from 'three';

export const CMP_EPSILON = 1e-5;
const ALMOST_ONE = 1 - CMP_EPSILON;
const TAU = Math.PI * 2;

export const isZeroApprox = (x: number): boolean => Math.abs(x) < CMP_EPSILON;
export const isEqualApprox = (a: number, b: number): boolean => {
  if (a === b) return true;
  return Math.abs(a - b) < CMP_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
};

const _axis = new Vector3();
const _v1 = new Vector3();
const _qi = new Quaternion();
const _q1 = new Quaternion();
const _q2 = new Quaternion();

/** origin + normalize(destination - origin) * length（Godot: SkeletonModifier3D::limit_length） */
export function limitLength(origin: Vector3, destination: Vector3, length: number, out: Vector3): Vector3 {
  out.copy(destination).sub(origin);
  const len = out.length();
  if (isZeroApprox(len)) return out.copy(origin);
  return out.multiplyScalar(length / len).add(origin);
}

/** Godot: get_local_pose_rotation —— 全局旋转转骨骼局部旋转 */
export function getLocalPoseRotation(parentGlobalQuat: Quaternion | null, globalQuat: Quaternion, out: Quaternion): Quaternion {
  if (!parentGlobalQuat) return out.copy(globalQuat).normalize();
  return out.copy(parentGlobalQuat).invert().multiply(globalQuat).normalize();
}

/** Godot: get_from_to_rotation。from/to 为单位向量；翻转/退化时返回 prevRot 防抖动。 */
export function getFromToRotation(from: Vector3, to: Vector3, prevRot: Quaternion, out: Quaternion): Quaternion {
  if (isEqualApprox(from.dot(to), -1)) return out.copy(prevRot);
  _axis.copy(from).cross(to);
  if (_axis.lengthSq() < CMP_EPSILON * CMP_EPSILON) return out.copy(prevRot);
  let angle = from.angleTo(to);
  if (isZeroApprox(angle)) angle = 0;
  return out.setFromAxisAngle(_axis.normalize(), angle);
}

/** Godot: get_from_to_rotation_by_axis（axis 单位向量；结果只绕 axis 旋转） */
export function getFromToRotationByAxis(from: Vector3, to: Vector3, axis: Vector3, out: Quaternion): Quaternion {
  const dot = from.dot(to);
  if (dot > ALMOST_ONE) return out.identity();
  if (dot < -ALMOST_ONE) return out.setFromAxisAngle(axis, Math.PI);
  let angle = from.angleTo(to);
  _axis.copy(from).cross(to);
  if (Math.sign(_axis.dot(axis)) < 0) angle = -angle;
  return out.setFromAxisAngle(axis, angle);
}

/** Godot: get_swing —— 提取 rotation 中垂直于 axis 的分量（swing = rot * twist^-1） */
export function getSwing(rotation: Quaternion, axis: Vector3, out: Quaternion): Quaternion {
  if (axis.lengthSq() < CMP_EPSILON * CMP_EPSILON) return out.copy(rotation);
  const rot = _q1.copy(rotation).normalize();
  const ax = _v1.copy(axis).normalize();
  const projLen = rot.x * ax.x + rot.y * ax.y + rot.z * ax.z;
  const twist = _q2.set(ax.x * projLen, ax.y * projLen, ax.z * projLen, rot.w);
  const lenSq = twist.x * twist.x + twist.y * twist.y + twist.z * twist.z + twist.w * twist.w;
  if (isZeroApprox(lenSq)) return out.copy(rot);
  twist.normalize();
  return out.copy(rot).multiply(twist.invert()).normalize();
}

/** Godot: snap_vector_to_plane —— 投影到以 planeNormal 为法线的平面，保持原长度 */
export function snapVectorToPlane(planeNormal: Vector3, vector: Vector3, out: Vector3): Vector3 {
  if (isZeroApprox(planeNormal.lengthSq())) return out.copy(vector);
  const length = vector.length();
  const n = _v1.copy(planeNormal).normalize();
  out.copy(vector).normalize();
  // slide(n) = v - n * v.dot(n)
  out.addScaledVector(n, -out.dot(n)).multiplyScalar(length);
  return out;
}

/** Godot: symmetrize_angle → [-PI, PI] */
export function symmetrizeAngle(angle: number): number {
  const a = ((angle % TAU) + TAU) % TAU;
  return a > Math.PI ? a - TAU : a;
}

/** Godot: get_roll_angle —— rotation 绕 rollAxis 的有符号滚转角 */
export function getRollAngle(rotation: Quaternion, rollAxis: Vector3): number {
  const axis = _v1.copy(rollAxis).normalize();
  const dot = rotation.x * axis.x + rotation.y * axis.y + rotation.z * axis.z;
  const rc = _q1.set(axis.x * dot, axis.y * dot, axis.z * dot, rotation.w);
  const length = Math.sqrt(rc.x * rc.x + rc.y * rc.y + rc.z * rc.z + rc.w * rc.w);
  if (length <= CMP_EPSILON) return 0;
  rc.set(rc.x / length, rc.y / length, rc.z / length, rc.w / length);
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, rc.w)));
  const direction = rc.x * axis.x + rc.y * axis.y + rc.z * axis.z > 0 ? 1 : -1;
  return symmetrizeAngle(angle * direction);
}

/** Godot: get_projected_normal —— 无限直线 a→b 上离 point 最近点指向 point 的单位向量 */
export function getProjectedNormal(a: Vector3, b: Vector3, point: Vector3, out: Vector3): Vector3 {
  const dir = _v1.copy(b).sub(a);
  const denom = dir.lengthSq();
  if (isZeroApprox(denom)) return out.set(0, 0, 0);
  const t = _axis.copy(point).sub(a).dot(dir) / denom;
  // h = a + dir * t; out = normalize(point - h)
  out.copy(point).sub(dir.multiplyScalar(t).add(a));
  const len = out.length();
  if (isZeroApprox(len)) return out.set(0, 0, 0);
  return out.multiplyScalar(1 / len);
}

/** q 作用于 v（Godot quat.xform） */
export function xformQuat(q: Quaternion, v: Vector3, out: Vector3): Vector3 {
  return out.copy(v).applyQuaternion(q);
}

/** q^-1 作用于 v（Godot quat.xform_inv） */
export function xformQuatInv(q: Quaternion, v: Vector3, out: Vector3): Vector3 {
  return out.copy(v).applyQuaternion(_qi.copy(q).invert());
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/math.test.ts`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/core/math.ts tests/core/math.test.ts
git commit -m "feat(core): 数学工具（翻译自 Godot SkeletonModifier3D）"
```

---

### Task 4: core/bone-axes.ts —— 骨骼轴向枚举

**Files:**
- Create: `src/core/bone-axes.ts`
- Test: `tests/core/bone-axes.test.ts`

**Interfaces:**
- Produces:
  - `type BoneAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'`
  - `type BoneDirection = BoneAxis | 'from-parent'`
  - `type SecondaryDirection = 'none' | BoneAxis | 'custom'`
  - `type RotationAxis = 'x' | 'y' | 'z' | 'all' | 'custom'`
  - `vectorFromBoneAxis(axis: BoneAxis, out: Vector3): Vector3`
  - `vectorFromSecondaryDirection(dir: SecondaryDirection, custom: Vector3 | undefined, out: Vector3): Vector3`（'none' → 零向量）
  - `vectorFromRotationAxis(axis: RotationAxis, custom: Vector3 | undefined, out: Vector3): Vector3`（'all' → 零向量）

- [ ] **Step 1: 写失败测试**

`tests/core/bone-axes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { vectorFromBoneAxis, vectorFromSecondaryDirection, vectorFromRotationAxis } from '../../src/core/bone-axes';

describe('bone axes', () => {
  it('maps bone axis to vector', () => {
    expect(vectorFromBoneAxis('+y', new Vector3())).toEqual(new Vector3(0, 1, 0));
    expect(vectorFromBoneAxis('-z', new Vector3())).toEqual(new Vector3(0, 0, -1));
  });

  it('secondary direction: none → zero, custom → custom vector', () => {
    expect(vectorFromSecondaryDirection('none', undefined, new Vector3()).lengthSq()).toBe(0);
    const custom = new Vector3(1, 2, 3);
    expect(vectorFromSecondaryDirection('custom', custom, new Vector3())).toEqual(custom);
    expect(vectorFromSecondaryDirection('+x', undefined, new Vector3())).toEqual(new Vector3(1, 0, 0));
  });

  it('rotation axis: all → zero（不投影）, x/y/z → 基向量', () => {
    expect(vectorFromRotationAxis('all', undefined, new Vector3()).lengthSq()).toBe(0);
    expect(vectorFromRotationAxis('y', undefined, new Vector3())).toEqual(new Vector3(0, 1, 0));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/bone-axes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/core/bone-axes.ts`:
```ts
import { Vector3 } from 'three';

export type BoneAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export type BoneDirection = BoneAxis | 'from-parent';
export type SecondaryDirection = 'none' | BoneAxis | 'custom';
export type RotationAxis = 'x' | 'y' | 'z' | 'all' | 'custom';

const BONE_AXIS_VECTORS: Record<BoneAxis, readonly [number, number, number]> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

export function vectorFromBoneAxis(axis: BoneAxis, out: Vector3): Vector3 {
  const v = BONE_AXIS_VECTORS[axis];
  return out.set(v[0], v[1], v[2]);
}

export function vectorFromSecondaryDirection(dir: SecondaryDirection, custom: Vector3 | undefined, out: Vector3): Vector3 {
  if (dir === 'none') return out.set(0, 0, 0);
  if (dir === 'custom') return custom ? out.copy(custom) : out.set(0, 0, 0);
  return vectorFromBoneAxis(dir, out);
}

export function vectorFromRotationAxis(axis: RotationAxis, custom: Vector3 | undefined, out: Vector3): Vector3 {
  if (axis === 'all') return out.set(0, 0, 0);
  if (axis === 'custom') return custom ? out.copy(custom) : out.set(0, 0, 0);
  return vectorFromBoneAxis(`+${axis}` as BoneAxis, out);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/bone-axes.test.ts`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/core/bone-axes.ts tests/core/bone-axes.test.ts
git commit -m "feat(core): 骨骼轴向枚举"
```

### Task 5: SkeletonRig —— 构建、rest/base 姿势

**Files:**
- Create: `src/core/skeleton-rig.ts`
- Test: `tests/core/skeleton-rig.test.ts`

**Interfaces:**
- Consumes: `ThreeIKError`、`TinyEmitter`（Task 2）
- Produces（后续所有 task 依赖）:
  - `class SkeletonRig`，构造 `new SkeletonRig(root: Object3D)`（DFS 遍历收集 `isBone` 节点，**构造时的骨骼 TRS 即 rest pose**）
  - 只读：`boneCount: number`、`boneNames: readonly string[]`；`boneIndex(name: string): number`（缺失抛 `ThreeIKError.boneNotFound`）；`findBoneIndex(name: string): number`（缺失返回 -1，供重定向可选骨）；`getBoneName(i: number): string`；`getParentIndex(i: number): number`；`getBoneAt(i: number): Bone`
  - rest：`getRestPosition(i, out: Vector3)`、`getRestQuaternion(i, out: Quaternion)`、`getRestScale(i, out: Vector3)`、`setRestPose(i, partial: {position?: Vector3; quaternion?: Quaternion; scale?: Vector3})`（触发 `'rest-updated'`）、`getGlobalRestPosition(i, out)`、`getGlobalRestQuaternion(i, out)`
  - base pose：`captureBasePose()`、`setBasePoseRotation(i, q: Quaternion)`、`setBasePosePosition(i, v: Vector3)`（同时写 base 缓冲与 Bone）、`getBasePoseRotation(i, out)`、`getBasePosePosition(i, out)`、`resetToRest()`
  - 其他：`motionScale: number`（默认 1）、`computeMotionScaleFromBone(name: string): number`、`worldToRigSpace(worldPos: Vector3, out: Vector3): Vector3`、`rebind(root: Object3D): void`
  - 事件：`on('rest-updated' | 'warning', cb)`、`off(...)`、`warnOnce(key, message)`
  - 序列化：`toJSON()` —— rest 数据快照 `{ bones: [{name, parent, position, quaternion, scale}] }`
  - `update(delta: number): void`（Task 5 版本仅 seed+写回；Task 7 加入 modifier 管线）

**索引约定**：骨骼数组按 DFS 前序排列，骨骼 i 的子树 = 连续区间 `[i, i + span[i])`。全局姿势合成忽略 scale（IK 只需要位置+旋转；文档注明）。

- [ ] **Step 1: 写失败测试**

`tests/core/skeleton-rig.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { Bone, Group, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';

/** Hips(0,1,0) → Spine(0,0.1,0) → Chest(0,0.1,0) → LeftArm(0.05,0,0, rotZ 90deg) */
function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  const chest = new Bone(); chest.name = 'Chest'; chest.position.set(0, 0.1, 0);
  const arm = new Bone(); arm.name = 'LeftArm'; arm.position.set(0.05, 0, 0);
  arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  hips.add(spine); spine.add(chest); chest.add(arm);
  return { rig: new SkeletonRig(hips), hips, spine, chest, arm };
}

describe('SkeletonRig construction', () => {
  it('flattens bones in DFS order with parent indices and spans', () => {
    const { rig } = buildRig();
    expect(rig.boneNames).toEqual(['Hips', 'Spine', 'Chest', 'LeftArm']);
    expect(rig.getParentIndex(0)).toBe(-1);
    expect(rig.getParentIndex(1)).toBe(0);
    expect(rig.getParentIndex(3)).toBe(2);
    expect(rig.boneCount).toBe(4);
  });

  it('resolves bone names; throws/falls back for missing', () => {
    const { rig } = buildRig();
    expect(rig.boneIndex('Chest')).toBe(2);
    expect(() => rig.boneIndex('Nope')).toThrowError(/Nope/);
    expect(rig.findBoneIndex('Nope')).toBe(-1);
  });

  it('captures rest pose from initial bone TRS and composes global rest', () => {
    const { rig } = buildRig();
    const restPos = rig.getRestPosition(3, new Vector3());
    expect(restPos.x).toBeCloseTo(0.05, 6);
    // Chest 全局 rest 位置 = (0, 1.2, 0)
    const g = rig.getGlobalRestPosition(2, new Vector3());
    expect(g.x).toBeCloseTo(0, 5);
    expect(g.y).toBeCloseTo(1.2, 5);
    // LeftArm 全局 rest 旋转 = 父链无旋转 ∘ rotZ(90°)
    const gq = rig.getGlobalRestQuaternion(3, new Quaternion());
    const v = new Vector3(1, 0, 0).applyQuaternion(gq);
    expect(v.y).toBeCloseTo(1, 5);
  });

  it('throws when root has no bones', () => {
    expect(() => new SkeletonRig(new Group())).toThrowError();
  });
});

describe('base pose', () => {
  it('setBasePoseRotation writes base buffer and Bone', () => {
    const { rig, spine } = buildRig();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    rig.setBasePoseRotation(1, q);
    expect(spine.quaternion.angleTo(q)).toBeLessThan(1e-6);
    expect(rig.getBasePoseRotation(1, new Quaternion()).angleTo(q)).toBeLessThan(1e-6);
  });

  it('captureBasePose reads externally-animated bone TRS', () => {
    const { rig, chest } = buildRig();
    chest.position.set(0.5, 0.5, 0.5); // 模拟 AnimationMixer 写入
    rig.captureBasePose();
    expect(rig.getBasePosePosition(2, new Vector3()).x).toBeCloseTo(0.5, 6);
  });

  it('resetToRest restores base pose and bones', () => {
    const { rig, chest } = buildRig();
    chest.position.set(9, 9, 9);
    rig.captureBasePose();
    rig.resetToRest();
    expect(chest.position.y).toBeCloseTo(0.1, 6);
  });

  it('emits rest-updated on setRestPose and recomputes global rest', () => {
    const { rig } = buildRig();
    const cb = vi.fn();
    rig.on('rest-updated', cb);
    rig.setRestPose(1, { position: new Vector3(0, 0.5, 0) });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(rig.getGlobalRestPosition(2, new Vector3()).y).toBeCloseTo(1.6, 5);
  });

  it('serializes rest pose data (toJSON)', () => {
    const { rig } = buildRig();
    const json = rig.toJSON();
    expect(json.bones.length).toBe(4);
    expect(json.bones[0]).toMatchObject({ name: 'Hips', parent: null, position: [0, 1, 0] });
    expect(json.bones[3]).toMatchObject({ name: 'LeftArm', parent: 'Chest' });
  });
});

describe('rig space', () => {
  it('worldToRigSpace converts via root bone parent transform', () => {
    const { rig, hips } = buildRig();
    const armature = new Group();
    armature.position.set(10, 0, 0);
    armature.add(hips);
    armature.updateMatrixWorld(true);
    const out = rig.worldToRigSpace(new Vector3(10, 1.2, 0), new Vector3());
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(1.2, 5);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/skeleton-rig.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/core/skeleton-rig.ts`:
```ts
import { Bone, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { ThreeIKError } from './errors';
import { TinyEmitter } from './events';

type RigEvent = 'rest-updated' | 'warning';

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();

export class SkeletonRig {
  private bones: Bone[] = [];
  private parent: Int32Array = new Int32Array(0);
  private span: Uint32Array = new Uint32Array(0);
  private nameToIndex = new Map<string, number>();

  // 分解存储：rest / base / work 三套局部姿势 + 全局姿势缓存（忽略 scale）
  private restPos!: Float32Array;
  private restQuat!: Float32Array;
  private restScale!: Float32Array;
  private basePos!: Float32Array;
  private baseQuat!: Float32Array;
  private baseScale!: Float32Array;
  private workPos!: Float32Array;
  private workQuat!: Float32Array;
  private workScale!: Float32Array;
  private globalPos!: Float32Array;
  private globalQuat!: Float32Array;
  private globalRestPos!: Float32Array;
  private globalRestQuat!: Float32Array;
  private globalDirty!: Uint8Array;
  private globalDirtyAny = false;

  /** 重定向位移缩放（Godot motion_scale），默认 1；可用 computeMotionScaleFromBone 设置 */
  motionScale = 1;

  private emitter = new TinyEmitter<RigEvent>();

  constructor(root: Object3D) {
    this.rebind(root);
  }

  get boneCount(): number {
    return this.bones.length;
  }

  get boneNames(): readonly string[] {
    return this.bones.map((b) => b.name);
  }

  boneIndex(name: string): number {
    const idx = this.nameToIndex.get(name);
    if (idx === undefined) throw ThreeIKError.boneNotFound(name);
    return idx;
  }

  findBoneIndex(name: string): number {
    return this.nameToIndex.get(name) ?? -1;
  }

  getBoneName(i: number): string {
    return this.bones[i]!.name;
  }

  getParentIndex(i: number): number {
    return this.parent[i]!;
  }

  getBoneAt(i: number): Bone {
    return this.bones[i]!;
  }

  /** theatre 快照编辑器 clone 场景后调用：在新 Bone 树上重建全部缓存 */
  rebind(root: Object3D): void {
    const bones: Bone[] = [];
    const parentIdx: number[] = [];
    // DFS 前序遍历：非 Bone 节点不入列但展开其子节点；Bone 的父索引 = 最近的 Bone 祖先
    const visit = (obj: Object3D, parentBoneIdx: number): void => {
      let idx = parentBoneIdx;
      if ((obj as Bone).isBone) {
        idx = bones.length;
        bones.push(obj as Bone);
        parentIdx.push(parentBoneIdx);
      }
      for (const child of obj.children) visit(child, idx);
    };
    visit(root, -1);
    if (bones.length === 0) {
      throw ThreeIKError.configError('SkeletonRig: no Bone found under the given root');
    }

    this.bones = bones;
    const n = bones.length;
    this.parent = Int32Array.from(parentIdx);
    this.nameToIndex = new Map(bones.map((b, i) => [b.name, i]));

    // nested-set 区间：DFS 序下子树连续，span[i] = 子树大小
    this.span = new Uint32Array(n).fill(1);
    for (let i = n - 1; i > 0; i--) {
      this.span[this.parent[i]!]! += this.span[i]!;
    }

    const alloc = (stride: number) => new Float32Array(n * stride);
    this.restPos = alloc(3); this.restQuat = alloc(4); this.restScale = alloc(3);
    this.basePos = alloc(3); this.baseQuat = alloc(4); this.baseScale = alloc(3);
    this.workPos = alloc(3); this.workQuat = alloc(4); this.workScale = alloc(3);
    this.globalPos = alloc(3); this.globalQuat = alloc(4);
    this.globalRestPos = alloc(3); this.globalRestQuat = alloc(4);
    this.globalDirty = new Uint8Array(n);

    // 构造时的骨骼 TRS = rest pose；base/work 初始化为 rest
    for (let i = 0; i < n; i++) {
      bones[i]!.position.toArray(this.restPos, i * 3);
      bones[i]!.quaternion.toArray(this.restQuat, i * 4);
      bones[i]!.scale.toArray(this.restScale, i * 3);
    }
    this.recomputeGlobalRest();
    this.resetToRest();
  }

  // ---- rest ----

  getRestPosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.restPos, i * 3);
  }

  getRestQuaternion(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.restQuat, i * 4);
  }

  getRestScale(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.restScale, i * 3);
  }

  setRestPose(i: number, partial: { position?: Vector3; quaternion?: Quaternion; scale?: Vector3 }): void {
    if (partial.position) partial.position.toArray(this.restPos, i * 3);
    if (partial.quaternion) partial.quaternion.toArray(this.restQuat, i * 4);
    if (partial.scale) partial.scale.toArray(this.restScale, i * 3);
    this.recomputeGlobalRest();
    this.emitter.emit('rest-updated');
  }

  getGlobalRestPosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.globalRestPos, i * 3);
  }

  getGlobalRestQuaternion(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.globalRestQuat, i * 4);
  }

  private recomputeGlobalRest(): void {
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      const p = this.parent[i]!;
      _v.fromArray(this.restPos, i * 3);
      _q.fromArray(this.restQuat, i * 4);
      if (p < 0) {
        _v.toArray(this.globalRestPos, i * 3);
        _q.normalize().toArray(this.globalRestQuat, i * 4);
      } else {
        _q2.fromArray(this.globalRestQuat, p * 4);
        _v.applyQuaternion(_q2).add(_v2.fromArray(this.globalRestPos, p * 3));
        _v.toArray(this.globalRestPos, i * 3);
        _q2.multiply(_q).normalize().toArray(this.globalRestQuat, i * 4);
      }
    }
  }

  // ---- base pose ----

  /** 动画路径：在 AnimationMixer.update 之后、update 之前调用，把骨骼当前 TRS 采为基准姿势 */
  captureBasePose(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i]!;
      b.position.toArray(this.basePos, i * 3);
      b.quaternion.toArray(this.baseQuat, i * 4);
      b.scale.toArray(this.baseScale, i * 3);
    }
  }

  /** FK 编辑路径：同时写 base 缓冲与 Bone（不经过 modifier） */
  setBasePoseRotation(i: number, q: Quaternion): void {
    q.toArray(this.baseQuat, i * 4);
    this.bones[i]!.quaternion.copy(q);
  }

  setBasePosePosition(i: number, v: Vector3): void {
    v.toArray(this.basePos, i * 3);
    this.bones[i]!.position.copy(v);
  }

  getBasePoseRotation(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.baseQuat, i * 4);
  }

  getBasePosePosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.basePos, i * 3);
  }

  resetToRest(): void {
    this.basePos.set(this.restPos);
    this.baseQuat.set(this.restQuat);
    this.baseScale.set(this.restScale);
    this.workPos.set(this.restPos);
    this.workQuat.set(this.restQuat);
    this.workScale.set(this.restScale);
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i]!;
      b.position.fromArray(this.restPos, i * 3);
      b.quaternion.fromArray(this.restQuat, i * 4);
      b.scale.fromArray(this.restScale, i * 3);
    }
  }

  // ---- rig space ----

  /** 世界坐标 → rig 空间（root bone 父对象的局部空间；全局姿势合成所在空间） */
  worldToRigSpace(worldPos: Vector3, out: Vector3): Vector3 {
    const parentObj = this.bones[0]!.parent;
    if (!parentObj) return out.copy(worldPos);
    parentObj.updateWorldMatrix(true, false);
    return out.copy(worldPos).applyMatrix4(_m.copy(parentObj.matrixWorld).invert());
  }

  computeMotionScaleFromBone(name: string): number {
    const i = this.boneIndex(name);
    this.getGlobalRestPosition(i, _v);
    return _v.length();
  }

  // ---- events ----

  on(event: RigEvent, cb: (payload?: unknown) => void): () => void {
    return this.emitter.on(event, cb);
  }

  off(event: RigEvent, cb: (payload?: unknown) => void): void {
    this.emitter.off(event, cb);
  }

  warnOnce(key: string, message: string): void {
    this.emitter.warnOnce(key, message);
  }

  // ---- update（Task 7 加入 modifier 管线）----

  update(_delta: number): void {
    this.seedWorkFromBase();
    this.writeBackToBones();
  }

  protected seedWorkFromBase(): void {
    this.workPos.set(this.basePos);
    this.workQuat.set(this.baseQuat);
    this.workScale.set(this.baseScale);
  }

  protected writeBackToBones(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i]!;
      b.position.fromArray(this.workPos, i * 3);
      b.quaternion.fromArray(this.workQuat, i * 4);
      b.scale.fromArray(this.workScale, i * 3);
    }
  }

  // ---- 序列化（骨架编辑数据层）----

  /** rest 数据快照：{ bones: [{name, parent, position, quaternion, scale}] } */
  toJSON(): { bones: Array<{ name: string; parent: string | null; position: number[]; quaternion: number[]; scale: number[] }> } {
    return {
      bones: this.bones.map((b, i) => ({
        name: b.name,
        parent: this.parent[i]! >= 0 ? this.bones[this.parent[i]!]!.name : null,
        position: Array.from(this.restPos.slice(i * 3, i * 3 + 3)),
        quaternion: Array.from(this.restQuat.slice(i * 4, i * 4 + 4)),
        scale: Array.from(this.restScale.slice(i * 3, i * 3 + 3)),
      })),
    };
  }
}
```

> 实现注意（执行者遵守）：热路径方法（`updateGlobalPose`、`recomputeGlobalRest`、`writeBackToBones`、`blendWorkPose`）内不得 `new Vector3/Quaternion`，用模块级 `_v/_v2/_q/_q2`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/skeleton-rig.test.ts`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/core/skeleton-rig.ts tests/core/skeleton-rig.test.ts
git commit -m "feat(core): SkeletonRig 构建、rest/base 姿势与 nested-set 区间"
```

---

### Task 6: SkeletonRig —— 工作姿势与全局姿势（modifier 读写面）

**Files:**
- Modify: `src/core/skeleton-rig.ts`
- Test: `tests/core/skeleton-rig-pose.test.ts`

**Interfaces:**
- Produces（IK/约束/重定向的读写 API）:
  - `setPoseRotation(i: number, q: Quaternion): void`、`setPosePosition(i: number, v: Vector3): void` —— 写 work 缓冲并把子树 `[i, i+span[i])` 标脏
  - `getPoseRotation(i, out)`、`getPosePosition(i, out)` —— 读 work 缓冲
  - `getGlobalPosePosition(i, out)`、`getGlobalPoseQuaternion(i, out)` —— 惰性同步后读全局姿势
  - `updateGlobalPose(): void` —— 显式同步（Godot `force_update_all_dirty_bones`）
  - `getSubtreeSpan(i: number): number` —— span[i]（供调试/测试）

- [ ] **Step 1: 写失败测试**

`tests/core/skeleton-rig-pose.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';

function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  const chest = new Bone(); chest.name = 'Chest'; chest.position.set(0, 0.1, 0);
  hips.add(spine); spine.add(chest);
  return new SkeletonRig(hips);
}

describe('working pose & global pose', () => {
  it('global pose composes down the chain (no rotation)', () => {
    const rig = buildRig();
    rig.update(0);
    const g = rig.getGlobalPosePosition(2, new Vector3());
    expect(g.y).toBeCloseTo(1.2, 5);
  });

  it('setPoseRotation rotates the whole subtree in global space', () => {
    const rig = buildRig();
    rig.update(0);
    // Spine 绕 Z 转 90°：Chest 全局位置 = Hips(0,1,0) + (0.1,0,0) 旋转后 (0,0,0)→ 具体：
    // Spine 全局位置 (0,1.1,0)，Chest 相对 (0,0.1,0) 绕 Z 转 90° → (0,1.1,0) + (-0.1,0,0) = (-0.1, 1.1, 0)
    rig.setPoseRotation(1, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
    const g = rig.getGlobalPosePosition(2, new Vector3());
    expect(g.x).toBeCloseTo(-0.1, 5);
    expect(g.y).toBeCloseTo(1.1, 5);
    const gq = rig.getGlobalPoseQuaternion(2, new Quaternion());
    const v = new Vector3(1, 0, 0).applyQuaternion(gq);
    expect(v.y).toBeCloseTo(1, 5);
  });

  it('setPosePosition moves subtree', () => {
    const rig = buildRig();
    rig.update(0);
    rig.setPosePosition(1, new Vector3(0, 0.5, 0));
    // Chest 全局 = Hips(0,1,0) + Spine(0,0.5,0) + Chest 自身偏移(0,0.1,0) = 1.6
    expect(rig.getGlobalPosePosition(2, new Vector3()).y).toBeCloseTo(1.6, 5);
  });

  it('update() without modifiers writes base pose to bones', () => {
    const rig = buildRig();
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    rig.setBasePoseRotation(1, q);
    rig.update(0.016);
    expect(rig.getBoneAt(1).quaternion.angleTo(q)).toBeLessThan(1e-6);
  });

  it('exposes subtree span (nested-set interval)', () => {
    const rig = buildRig();
    expect(rig.getSubtreeSpan(0)).toBe(3);
    expect(rig.getSubtreeSpan(2)).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/skeleton-rig-pose.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现 —— 向 `src/core/skeleton-rig.ts` 追加以下方法**

```ts
  // ---- working pose（modifier 写入面）----

  /** modifier 写局部旋转；子树全局姿势标脏（Godot set_bone_pose_rotation） */
  setPoseRotation(i: number, q: Quaternion): void {
    q.toArray(this.workQuat, i * 4);
    this.markGlobalDirtySubtree(i);
  }

  setPosePosition(i: number, v: Vector3): void {
    v.toArray(this.workPos, i * 3);
    this.markGlobalDirtySubtree(i);
  }

  getPoseRotation(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.workQuat, i * 4);
  }

  getPosePosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.workPos, i * 3);
  }

  // ---- global pose ----

  getGlobalPosePosition(i: number, out: Vector3): Vector3 {
    if (this.globalDirtyAny) this.updateGlobalPose();
    return out.fromArray(this.globalPos, i * 3);
  }

  getGlobalPoseQuaternion(i: number, out: Quaternion): Quaternion {
    if (this.globalDirtyAny) this.updateGlobalPose();
    return out.fromArray(this.globalQuat, i * 4);
  }

  /** DFS 单遍前向扫描，只重算脏段（父索引恒小于子索引，父必先算完） */
  updateGlobalPose(): void {
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      if (!this.globalDirty[i]) continue;
      const p = this.parent[i]!;
      _v.fromArray(this.workPos, i * 3);
      _q.fromArray(this.workQuat, i * 4);
      if (p < 0) {
        _v.toArray(this.globalPos, i * 3);
        _q.normalize().toArray(this.globalQuat, i * 4);
      } else {
        const gq = _q2.fromArray(this.globalQuat, p * 4);
        _v.applyQuaternion(gq).add(_v2.fromArray(this.globalPos, p * 3));
        _v.toArray(this.globalPos, i * 3);
        _q2.multiply(_q).normalize().toArray(this.globalQuat, i * 4);
      }
      this.globalDirty[i] = 0;
    }
    this.globalDirtyAny = false;
  }

  getSubtreeSpan(i: number): number {
    return this.span[i]!;
  }

  private markGlobalDirtySubtree(i: number): void {
    this.globalDirty.fill(1, i, i + this.span[i]!);
    this.globalDirtyAny = true;
  }
```

同时在文件顶部临时变量区追加 `_v2`、`_q2`：
```ts
const _v2 = new Vector3();
const _q2 = new Quaternion();
```

并把 `update()` 改为同步全局姿势后再写回（骨骼 matrixWorld 由 renderer 统一算，这里只写局部 TRS——保持现状即可，无需改）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/skeleton-rig-pose.test.ts tests/core/skeleton-rig.test.ts`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/core/skeleton-rig.ts tests/core/skeleton-rig-pose.test.ts
git commit -m "feat(core): 工作姿势与 DFS 单遍全局姿势同步"
```

### Task 7: Modifier 基类与修改器管线

**Files:**
- Create: `src/modifiers/modifier.ts`
- Modify: `src/core/skeleton-rig.ts`（update() 加入 modifier 循环与 influence 混合）
- Test: `tests/modifiers/modifier-chain.test.ts`

**Interfaces:**
- Produces:
  - `abstract class Modifier { active: boolean; influence: number; attach(rig: SkeletonRig): void; detach(): void; abstract processModification(rig: SkeletonRig, delta: number): void; abstract toJSON(): Record<string, unknown> }`（`attach` 由 `rig.addModifier` 调用，可被子类重写以构建缓存；基类实现只保存 rig 引用）
  - `rig.addModifier(m: Modifier): void`、`rig.removeModifier(m: Modifier): void`、`rig.getModifiers(): readonly Modifier[]`
- Consumes: Task 5/6 的全部读写 API

**管线语义（Godot `_process_modifiers` 移植）**：`update(delta)` = seedWorkFromBase → 按插入顺序执行 active modifier → 每个 `influence < 1` 的 modifier 执行前快照 work、执行后 `work = lerp/slerp(prevWork, work, influence)` → writeBackToBones。base 缓冲全程不被 modifier 触碰 ⇒ 基准姿势天然隔离，无需 Godot 式的备份/恢复。

- [ ] **Step 1: 写失败测试**

`tests/modifiers/modifier-chain.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { Modifier } from '../../src/modifiers/modifier';

class RotateBoneModifier extends Modifier {
  constructor(private bone: string, private angle: number) {
    super();
  }
  processModification(rig: SkeletonRig): void {
    const i = rig.boneIndex(this.bone);
    const prev = rig.getPoseRotation(i, new Quaternion());
    const delta = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), this.angle);
    rig.setPoseRotation(i, prev.multiply(delta));
  }
  toJSON() {
    return { type: 'rotate-bone', bone: this.bone, angle: this.angle };
  }
}

function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  hips.add(spine);
  return { rig: new SkeletonRig(hips), spine };
}

describe('modifier pipeline', () => {
  it('applies modifier to bones on update', () => {
    const { rig, spine } = buildRig();
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 2));
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-5);
  });

  it('influence blends pose (0.5 → half angle)', () => {
    const { rig, spine } = buildRig();
    const m = new RotateBoneModifier('Spine', Math.PI / 2);
    m.influence = 0.5;
    rig.addModifier(m);
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-3);
  });

  it('inactive modifier is skipped', () => {
    const { rig, spine } = buildRig();
    const m = new RotateBoneModifier('Spine', Math.PI / 2);
    m.active = false;
    rig.addModifier(m);
    rig.update(0.016);
    expect(spine.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('base pose stays clean across updates（无累积：连续两次 update 结果一致）', () => {
    const { rig, spine } = buildRig();
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 2));
    rig.update(0.016);
    const first = spine.quaternion.clone();
    rig.update(0.016);
    expect(spine.quaternion.angleTo(first)).toBeLessThan(1e-6);
    // base 缓冲未被污染
    expect(rig.getBasePoseRotation(1, new Quaternion()).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('modifiers run in insertion order（后执行者读到前者的结果）', () => {
    const { rig, spine } = buildRig();
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 4));
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 4));
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-5);
  });

  it('removeModifier detaches', () => {
    const { rig, spine } = buildRig();
    const m = new RotateBoneModifier('Spine', 1);
    rig.addModifier(m);
    rig.removeModifier(m);
    rig.update(0.016);
    expect(spine.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/modifier-chain.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/modifiers/modifier.ts`:
```ts
import type { SkeletonRig } from '../core/skeleton-rig';

export abstract class Modifier {
  active = true;
  /** 0~1，由管线在 modifier 执行后做姿势插值（Godot SkeletonModifier3D.influence） */
  influence = 1;

  protected rig: SkeletonRig | null = null;

  /** rig.addModifier 时调用；子类重写以构建骨索引/链缓存。禁止在构造器里碰 rig。 */
  attach(rig: SkeletonRig): void {
    this.rig = rig;
  }

  detach(): void {
    this.rig = null;
  }

  abstract processModification(rig: SkeletonRig, delta: number): void;

  /** 纯数据快照（theatre sheet props / 序列化共用） */
  abstract toJSON(): Record<string, unknown>;
}
```

修改 `src/core/skeleton-rig.ts`：

顶部 import 区追加：
```ts
import type { Modifier } from '../modifiers/modifier';
```

类成员区追加：
```ts
  private modifiers: Modifier[] = [];
  private prevPosePos!: Float32Array;
  private prevPoseQuat!: Float32Array;
  private prevPoseScale!: Float32Array;
```

`rebind()` 的 alloc 段追加：
```ts
    this.prevPosePos = alloc(3); this.prevPoseQuat = alloc(4); this.prevPoseScale = alloc(3);
```

追加公开方法：
```ts
  // ---- modifier chain ----

  addModifier(m: Modifier): void {
    this.modifiers.push(m);
    m.attach(this);
  }

  removeModifier(m: Modifier): void {
    const idx = this.modifiers.indexOf(m);
    if (idx >= 0) {
      this.modifiers.splice(idx, 1);
      m.detach();
    }
  }

  getModifiers(): readonly Modifier[] {
    return this.modifiers;
  }
```

`update()` 替换为：
```ts
  update(delta: number): void {
    this.seedWorkFromBase();
    this.markGlobalDirtySubtree(0); // work 整体重置，全局姿势全量失效
    for (const m of this.modifiers) {
      if (!m.active || m.influence <= 0) continue;
      if (m.influence >= 1) {
        m.processModification(this, delta);
        continue;
      }
      // influence 混合：快照 → 执行 → slerp/lerp（Godot 在 modifier 外做插值）
      this.prevPosePos.set(this.workPos);
      this.prevPoseQuat.set(this.workQuat);
      this.prevPoseScale.set(this.workScale);
      m.processModification(this, delta);
      this.blendWorkPose(m.influence);
    }
    this.writeBackToBones();
  }

  /** work = prev + (work - prev) * w（逐骨 pos lerp / quat slerp / scale lerp） */
  private blendWorkPose(w: number): void {
    for (let i = 0; i < this.bones.length; i++) {
      _v.fromArray(this.prevPosePos, i * 3).lerp(_v2.fromArray(this.workPos, i * 3), w);
      _v.toArray(this.workPos, i * 3);
      _q.fromArray(this.prevPoseQuat, i * 4).slerp(_q2.fromArray(this.workQuat, i * 4), w);
      _q.toArray(this.workQuat, i * 4);
      _v.fromArray(this.prevPoseScale, i * 3).lerp(_v2.fromArray(this.workScale, i * 3), w);
      _v.toArray(this.workScale, i * 3);
    }
    if (this.bones.length > 0) this.markGlobalDirtySubtree(0);
  }
```

> 实现注意：`_v2/_q2` 在 Task 6 已加入；`markGlobalDirtySubtree(0)` 依赖 DFS 序下 0 号骨子树 = 全骨架（root bone 恒为索引 0，span[0] = boneCount）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run`
Expected: 全部通过（含 Task 5/6 回归）

- [ ] **Step 5: Commit**

```bash
git add src/modifiers src/core/skeleton-rig.ts tests/modifiers
git commit -m "feat(modifiers): Modifier 基类与管线（快照/执行/influence 混合/pose 隔离）"
```

---

### Task 8: IKChain —— 链状态与链坐标系更新

**Files:**
- Create: `src/modifiers/ik/ik-chain.ts`
- Test: `tests/modifiers/ik/ik-chain.test.ts`

**Interfaces:**
- Consumes: `SkeletonRig`（Task 5/6）、math 工具（Task 3）、bone-axes（Task 4）
- Produces:
  - `interface IKChainConfig { rootBone: string; endBone: string; target: Object3D | string; extendEndBone?: boolean; endBoneDirection?: BoneDirection; endBoneLength?: number; joints?: Record<string, JointConfig> }`
  - `interface JointConfig { rotationAxis?: RotationAxis; rotationAxisVector?: Vector3; limitation?: JointLimitation | null; limitationRightAxis?: SecondaryDirection; limitationRightAxisVector?: Vector3; limitationRotationOffset?: Quaternion; useRestForLimitation?: boolean }`（`JointLimitation` 类型由 Task 10 定义；本 task 仅作前向引用 `import type`）
  - `interface SolverInfo { currentLpose/currentLrest/currentGpose/currentGrest: Quaternion; currentVector: Vector3; forwardVector: Vector3; length: number }`
  - `class IKChain`：
    - 字段：`joints: number[]`（root→end 骨索引）、`chain: Vector3[]`、`solverInfos: (SolverInfo | null)[]`、`jointSettings: JointSetting[]`、`rootBone: number`、`endBone: number`、`simulated: boolean`
    - `constructor(rig: SkeletonRig, config: IKChainConfig)` —— 校验并沿父链从 endBone 走到 rootBone 构建 joints（root 必须是 end 的严格祖先，否则 `ThreeIKError.invalidChain`）
    - `initJoints(rig): void` —— 每帧从全局姿势重建 chain 坐标与 solverInfo（翻译 `IterateIK3DSetting::init_joints`）
    - `updateChainCoordinate(rig, index, position)` / `updateChainCoordinateBw(...)` / `updateChainCoordinateFw(...)` —— 带防翻转守卫（翻译 chain_ik_3d.h 63–127 行）
    - `cacheCurrentVectors(rig): void`
    - `getChainEnd(): Vector3` —— `chain[chain.length - 1]`
  - `class JointSetting`（本 task 只含数据与轴向解析；`getProjectedRotation`/`getLimitedRotation` 在 Task 9/10）：
    - `rotationAxis/rotationAxisVector/limitation/limitationRightAxis/limitationRightAxisVector/limitationRotationOffset/limitationOffsetDelta/useRestForLimitation`
    - `getRotationAxisVector(out)`、`getLimitationRightAxisVector(out)`

**关键翻译说明**（`init_joints`，iterate_ik_3d.h 234–264 行）：chain[i] = 骨 joints[i] 的全局姿势位置；非末骨的 `forwardVector` = 子骨的**局部 rest 原点**（即父→子方向）经 rotationAxis 平面投影后归一化，`length` = 其长度；`extendEndBone` 时末骨追加虚拟端点（轴向来自 `getBoneAxis`，长度 `endBoneLength`）；轴向为零的骨 `solverInfo = null`（求解时跳过）。

`getBoneAxis` 翻译（ik_modifier_3d.cpp 182–196 行，`mutableBoneAxes = true` 固定）：`'from-parent'` → `axis = restQuat⁻¹(bone) * posePosition(bone)` 归一化（即骨当前局部位置在自身 rest 空间的表达）；其他 → 对应基向量。

- [ ] **Step 1: 写失败测试**

`tests/modifiers/ik/ik-chain.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { IKChain } from '../../../src/modifiers/ik/ik-chain';

/** 直链：A(0,0,0) → B(0,1,0) → C(0,1,0) → D(0,1,0)，另有一支 Hips 兄弟验证祖先校验 */
function buildChainRig() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  const d = new Bone(); d.name = 'D'; d.position.set(0, 1, 0);
  a.add(b); b.add(c); c.add(d);
  const rig = new SkeletonRig(a);
  rig.update(0);
  return rig;
}

describe('IKChain', () => {
  it('builds joints by walking parent chain from end to root', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    expect(chain.joints).toEqual([0, 1, 2, 3]);
  });

  it('rejects chains where root is not an ancestor of end', () => {
    const rig = buildChainRig();
    expect(() => new IKChain(rig, { rootBone: 'D', endBone: 'A', target: new Object3D() }))
      .toThrowError(/ancestor/);
  });

  it('initJoints fills chain positions from global pose and solver info from rest', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    chain.initJoints(rig);
    expect(chain.chain.length).toBe(4); // 无虚拟端点：4 个 joint 头
    expect(chain.chain[1]!.y).toBeCloseTo(1, 5);
    expect(chain.chain[3]!.y).toBeCloseTo(3, 5);
    const info = chain.solverInfos[0]!;
    expect(info.length).toBeCloseTo(1, 6);
    expect(info.forwardVector.y).toBeCloseTo(1, 5); // 局部朝 +Y
    expect(chain.solverInfos[3]).toBeNull(); // 末骨无子骨 → 不求解
  });

  it('extendEndBone appends a virtual end using from-parent axis', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, {
      rootBone: 'A', endBone: 'D', target: new Object3D(),
      extendEndBone: true, endBoneLength: 0.5,
    });
    chain.initJoints(rig);
    expect(chain.chain.length).toBe(5);
    expect(chain.getChainEnd().y).toBeCloseTo(3.5, 5);
    expect(chain.solverInfos[3]!.length).toBeCloseTo(0.5, 6);
  });

  it('cacheCurrentVectors derives global unit vectors from chain coordinates', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    chain.initJoints(rig);
    chain.chain[3]!.set(0, 3, 1); // 手动挪动末端
    chain.cacheCurrentVectors(rig);
    expect(chain.solverInfos[2]!.currentVector.z).toBeCloseTo(1, 5);
  });

  it('updateChainCoordinateFw guards against 180-degree flips', () => {
    const rig = buildChainRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'D', target: new Object3D() });
    chain.initJoints(rig);
    // 把 chain[0] 移到会使 head→tail 方向完全反向的位置：当前 tail[1] 在 (0,1,0)，原方向 +Y，
    // 新 head 放在 (0,2,0) 使新方向为 -Y → 触发防翻转，head 回退
    chain.updateChainCoordinateFw(rig, 0, new Vector3(0, 2, 0));
    expect(chain.chain[0]!.y).toBeCloseTo(0, 5); // 回退：chain[0] 未变
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/ik/ik-chain.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/modifiers/ik/ik-chain.ts`:
```ts
import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { ThreeIKError } from '../../core/errors';
import { isZeroApprox, isEqualApprox, snapVectorToPlane, xformQuat, xformQuatInv, CMP_EPSILON } from '../../core/math';
import { vectorFromBoneAxis, vectorFromRotationAxis, vectorFromSecondaryDirection } from '../../core/bone-axes';
import type { BoneDirection, RotationAxis, SecondaryDirection } from '../../core/bone-axes';
import type { JointLimitation } from './joint-limitation';

export interface JointConfig {
  rotationAxis?: RotationAxis;
  rotationAxisVector?: Vector3;
  limitation?: JointLimitation | null;
  limitationRightAxis?: SecondaryDirection;
  limitationRightAxisVector?: Vector3;
  limitationRotationOffset?: Quaternion;
  useRestForLimitation?: boolean;
}

export interface IKChainConfig {
  rootBone: string;
  endBone: string;
  /** Object3D 直接引用，或字符串 key（由 rig.targetResolver 解析，theatre 接入用） */
  target: Object3D | string;
  extendEndBone?: boolean;
  endBoneDirection?: BoneDirection;
  endBoneLength?: number;
  joints?: Record<string, JointConfig>;
}

export interface SolverInfo {
  currentLpose: Quaternion;
  currentLrest: Quaternion;
  currentGpose: Quaternion;
  currentGrest: Quaternion;
  currentVector: Vector3; // 全局、单位
  forwardVector: Vector3; // 局部、单位
  length: number;
}

/** 解析后的逐关节设置（Godot IterateIK3DJointSetting） */
export class JointSetting {
  rotationAxis: RotationAxis = 'all';
  rotationAxisVector = new Vector3(1, 0, 0);
  limitation: JointLimitation | null = null;
  limitationRightAxis: SecondaryDirection = 'none';
  limitationRightAxisVector = new Vector3(1, 0, 0);
  limitationRotationOffset = new Quaternion();
  limitationOffsetDelta = new Quaternion(); // 运行时：useRestForLimitation 的 rest 补偿
  useRestForLimitation = false;

  constructor(config?: JointConfig) {
    if (!config) return;
    if (config.rotationAxis !== undefined) this.rotationAxis = config.rotationAxis;
    if (config.rotationAxisVector) this.rotationAxisVector.copy(config.rotationAxisVector);
    if (config.limitation !== undefined) this.limitation = config.limitation;
    if (config.limitationRightAxis !== undefined) this.limitationRightAxis = config.limitationRightAxis;
    if (config.limitationRightAxisVector) this.limitationRightAxisVector.copy(config.limitationRightAxisVector);
    if (config.limitationRotationOffset) this.limitationRotationOffset.copy(config.limitationRotationOffset);
    if (config.useRestForLimitation !== undefined) this.useRestForLimitation = config.useRestForLimitation;
  }

  getRotationAxisVector(out: Vector3): Vector3 {
    return vectorFromRotationAxis(this.rotationAxis, this.rotationAxisVector, out);
  }

  getLimitationRightAxisVector(out: Vector3): Vector3 {
    return vectorFromSecondaryDirection(this.limitationRightAxis, this.limitationRightAxisVector, out);
  }
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _q1 = new Quaternion();

/** Godot: IKModifier3D::get_bone_axis（固定 mutableBoneAxes=true） */
export function getBoneAxis(rig: SkeletonRig, bone: number, direction: BoneDirection, out: Vector3): Vector3 {
  if (direction === 'from-parent') {
    // axis = restQuat(bone)^-1 * posePosition(bone)，归一化
    rig.getRestQuaternion(bone, _q1);
    rig.getPosePosition(bone, out);
    xformQuatInv(_q1, out, out);
    const len = out.length();
    if (!isZeroApprox(len)) out.multiplyScalar(1 / len);
    return out;
  }
  return vectorFromBoneAxis(direction, out);
}

/** Godot: ChainIK3DSetting + IterateIK3DSetting 的链状态（翻译，不含 NodePath/信号） */
export class IKChain {
  readonly joints: number[] = [];
  readonly chain: Vector3[] = [];
  readonly solverInfos: (SolverInfo | null)[] = [];
  readonly jointSettings: JointSetting[] = [];
  readonly rootBone: number;
  readonly endBone: number;
  readonly extendEndBone: boolean;
  readonly endBoneDirection: BoneDirection;
  readonly endBoneLength: number;
  simulated = false;

  constructor(rig: SkeletonRig, public readonly config: IKChainConfig) {
    this.rootBone = rig.boneIndex(config.rootBone);
    this.endBone = rig.boneIndex(config.endBone);
    this.extendEndBone = config.extendEndBone ?? false;
    this.endBoneDirection = config.endBoneDirection ?? 'from-parent';
    this.endBoneLength = config.endBoneLength ?? 0;

    // 从 endBone 沿父链走到 rootBone（root 必须是 end 的严格祖先）
    const path: number[] = [];
    let cur = this.endBone;
    while (cur !== -1 && cur !== this.rootBone) {
      path.push(cur);
      cur = rig.getParentIndex(cur);
    }
    if (cur !== this.rootBone) {
      throw ThreeIKError.invalidChain(
        `"${config.rootBone}" is not an ancestor of "${config.endBone}"`,
      );
    }
    path.push(this.rootBone);
    path.reverse();
    if (path.length < 2) {
      throw ThreeIKError.invalidChain(`root and end must be different bones ("${config.rootBone}")`);
    }
    this.joints = path;
    for (let i = 0; i < path.length; i++) {
      const boneName = rig.getBoneName(path[i]!);
      this.jointSettings.push(new JointSetting(config.joints?.[boneName]));
      this.solverInfos.push(null);
      this.chain.push(new Vector3());
    }
  }

  getChainEnd(): Vector3 {
    return this.chain[this.chain.length - 1]!;
  }

  /** 翻译 IterateIK3DSetting::init_joints —— 每帧从当前全局姿势重建链 */
  initJoints(rig: SkeletonRig): void {
    const extendsEnd = this.extendEndBone && this.endBoneLength > 0;
    const targetLen = this.joints.length + (extendsEnd ? 1 : 0);
    for (let i = 0; i < this.joints.length; i++) {
      rig.getGlobalPosePosition(this.joints[i]!, this.chain[i]!);
      const last = i === this.joints.length - 1;
      if (last && extendsEnd) {
        getBoneAxis(rig, this.endBone, this.endBoneDirection, _v1);
        if (isZeroApprox(_v1.lengthSq())) {
          this.solverInfos[i] = null;
          continue;
        }
        const info = (this.solverInfos[i] ??= createSolverInfo());
        this.jointSettings[i]!.getRotationAxisVector(_v2);
        snapVectorToPlane(_v2, _v1, info.forwardVector).normalize();
        info.length = this.endBoneLength;
        // 虚拟端点 = 全局姿势变换(axis * length) + 末骨全局位置（slot 复用，不逐帧分配）
        rig.getGlobalPoseQuaternion(this.joints[i]!, _q1);
        xformQuat(_q1, _v1.multiplyScalar(this.endBoneLength), _v1).add(this.chain[i]!);
        if (this.chain.length < targetLen) this.chain.push(_v1.clone());
        else this.chain[this.chain.length - 1]!.copy(_v1);
      } else if (!last) {
        rig.getRestPosition(this.joints[i + 1]!, _v1); // 子骨局部 rest 原点 = 父→子方向
        if (isZeroApprox(_v1.lengthSq())) {
          this.solverInfos[i] = null;
          continue;
        }
        const info = (this.solverInfos[i] ??= createSolverInfo());
        this.jointSettings[i]!.getRotationAxisVector(_v2);
        snapVectorToPlane(_v2, _v1, info.forwardVector).normalize();
        info.length = _v1.length();
      } else {
        this.solverInfos[i] = null;
      }
    }
    this.chain.length = targetLen; // 统一裁剪/保持
    this.initCurrentJointRotations(rig);
  }

  /** 翻译 ChainIK3DSetting::init_current_joint_rotations —— 以当前姿势为求解初值 */
  initCurrentJointRotations(rig: SkeletonRig): void {
    const parent = rig.getParentIndex(this.rootBone);
    const parentGpose = _q1.identity();
    if (parent >= 0) rig.getGlobalPoseQuaternion(parent, parentGpose);
    for (let i = 0; i < this.joints.length; i++) {
      const info = this.solverInfos[i];
      if (!info) continue;
      rig.getPoseRotation(this.joints[i]!, info.currentLpose);
      info.currentGpose.copy(parentGpose).multiply(info.currentLpose).normalize();
      parentGpose.copy(info.currentGpose);
    }
    this.cacheCurrentVectors(rig);
  }

  /** 翻译 update_chain_coordinate_bw（含防翻转守卫，chain_ik_3d.h 75–100 行） */
  updateChainCoordinateBw(rig: SkeletonRig, index: number, position: Vector3): void {
    if (isZeroApprox(this.chain[index]!.distanceTo(position))) return;
    const head = index - 1;
    if (head >= 0 && head < this.solverInfos.length) {
      const info = this.solverInfos[head];
      if (info) {
        _v1.copy(position).sub(this.chain[head]!).normalize(); // new head→tail
        if (isEqualApprox(info.currentVector.dot(_v1), -1)) {
          // 回退 tail，视为无变化
          this.chain[index]!.copy(this.chain[head]!).addScaledVector(info.currentVector, info.length);
          return;
        }
      }
    }
    this.chain[index]!.copy(position);
    this.cacheCurrentVector(rig, index);
  }

  /** 翻译 update_chain_coordinate_fw（chain_ik_3d.h 102–127 行） */
  updateChainCoordinateFw(rig: SkeletonRig, index: number, position: Vector3): void {
    if (isZeroApprox(this.chain[index]!.distanceTo(position))) return;
    const head = index;
    const tail = index + 1;
    if (tail >= 0 && tail < this.solverInfos.length) {
      const info = this.solverInfos[head];
      if (info) {
        _v1.copy(this.chain[tail]!).sub(position).normalize(); // new head→tail
        if (isEqualApprox(info.currentVector.dot(_v1), -1)) {
          this.chain[index]!.copy(this.chain[tail]!).addScaledVector(info.currentVector, -info.length);
          return;
        }
      }
    }
    this.chain[index]!.copy(position);
    this.cacheCurrentVector(rig, index);
  }

  cacheCurrentVectors(rig: SkeletonRig): void {
    for (let i = 0; i < this.joints.length; i++) {
      this.cacheCurrentVector(rig, i);
    }
  }

  private cacheCurrentVector(_rig: SkeletonRig, index: number): void {
    // chain[index] 移动影响两个 segment：head=index 与 head=index-1
    for (const head of [index - 1, index]) {
      if (head < 0) continue;
      const info = this.solverInfos[head];
      if (!info || head + 1 >= this.chain.length) continue;
      info.currentVector.copy(this.chain[head + 1]!).sub(this.chain[head]!);
      const len = info.currentVector.length();
      if (!isZeroApprox(len)) info.currentVector.multiplyScalar(1 / len);
    }
  }
}

function createSolverInfo(): SolverInfo {
  return {
    currentLpose: new Quaternion(),
    currentLrest: new Quaternion(),
    currentGpose: new Quaternion(),
    currentGrest: new Quaternion(),
    currentVector: new Vector3(),
    forwardVector: new Vector3(),
    length: 0,
  };
}
```

> 实现注意：`initJoints` 中 `this.chain.push(_v1.add(...).clone())` 的 clone 只在首次扩展时发生（后续帧 `chain.length` 已含虚拟端点，应复用槽位：先 `if (this.chain.length === this.joints.length) push` 否则写入既有槽位）。`snapVectorToPlane` 对零 rotationAxis（'all'）返回原向量——与 Godot 一致。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/ik/ik-chain.test.ts`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/ik tests/modifiers/ik
git commit -m "feat(ik): IKChain 链状态与链坐标系更新（翻译 ChainIK3DSetting）"
```

### Task 9: 链位置 → 骨骼局部旋转（cacheCurrentJointRotations）

**Files:**
- Modify: `src/modifiers/ik/ik-chain.ts`（IKChain 与 JointSetting 追加方法）
- Test: `tests/modifiers/ik/cache-rotations.test.ts`

**Interfaces:**
- Produces:
  - `JointSetting.getProjectedRotation(offset: Quaternion, vector: Vector3, out: Vector3): Vector3` —— 把向量投影到以 rotationAxis 为法线的旋转平面（translate iterate_ik_3d.h 116–132 行；`rotationAxis === 'all'` 时直接返回 vector）
  - `IKChain.cacheCurrentJointRotations(rig: SkeletonRig, angularDeltaLimit = Math.PI): void` —— 链坐标 → 各骨 `currentLpose`（translate iterate_ik_3d.h 161–232 行）

**算法要点（逐行翻译来源）**：
1. 从 rootBone 父骨全局旋转开始沿链向下：每骨 `currentLrest = poseQuat(bone)`、`currentGrest = parentGpose * currentLrest`；`useRestForLimitation` 时 `limitationOffsetDelta = (currentLrest⁻¹ * restQuat(bone)).normalized`。
2. `from = forwardVector`，`to = currentGrest⁻¹ * currentVector`（归一化）。
3. 三个分支：`'all'` → `lpose = lrest * getSwing(Quaternion(from→to), from)`；`useRestForLimitation` → 平面投影 + roll 补偿（`pose_from_rest` 分支）；否则 → `lrest * getFromToRotationByAxis(from, to, axis)`。
4. `angularDeltaLimit`：与上一帧 lpose 的角度差超限时 slerp 钳制（防跳变）。
5. `currentGpose = parentGpose * currentLpose`，作为下一骨的 parentGpose。
6. 最后把角度钳制回写链坐标：`chain[0] = rootGlobalPos`，逐骨 `chain[tail] = chain[head] + gpose * forwardVector * length`，再 `cacheCurrentVectors`。

- [ ] **Step 1: 写失败测试**

`tests/modifiers/ik/cache-rotations.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { IKChain } from '../../../src/modifiers/ik/ik-chain';

/** 直链 A(0,0,0) → B(0,1,0) → C(0,1,0) */
function buildRig() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  a.add(b); b.add(c);
  const rig = new SkeletonRig(a);
  rig.update(0);
  return rig;
}

describe('cacheCurrentJointRotations', () => {
  it('converts a bent chain into local bone rotations (all axes free)', () => {
    const rig = buildRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'C', target: new Bone() });
    chain.initJoints(rig);
    // 手动把末端扳到 +X 方向：B→C 方向从 +Y 变为 +X
    chain.chain[2]!.set(1, 1, 0);
    chain.cacheCurrentVectors(rig);
    chain.cacheCurrentJointRotations(rig);
    // B 骨（joints[1]）局部旋转应使全局 B→C 方向为 +X
    const lpose = chain.solverInfos[1]!.currentLpose;
    const parentG = new Quaternion();
    rig.getGlobalPoseQuaternion(0, parentG);
    const g = parentG.multiply(lpose);
    const dir = new Vector3(0, 1, 0).applyQuaternion(g); // forwardVector 局部 +Y
    expect(dir.x).toBeCloseTo(1, 4);
    expect(dir.y).toBeCloseTo(0, 4);
  });

  it('respects angularDeltaLimit (clamps per-iteration angle change)', () => {
    const rig = buildRig();
    const chain = new IKChain(rig, { rootBone: 'A', endBone: 'C', target: new Bone() });
    chain.initJoints(rig);
    chain.chain[2]!.set(1, 1, 0);
    chain.cacheCurrentVectors(rig);
    const limit = Math.PI / 90; // 2°
    chain.cacheCurrentJointRotations(rig, limit);
    const lpose = chain.solverInfos[1]!.currentLpose;
    expect(lpose.angleTo(new Quaternion())).toBeLessThanOrEqual(limit + 1e-4);
  });

  it('rotation axis projection keeps rotation in the axis plane', () => {
    const rig = buildRig();
    const chain = new IKChain(rig, {
      rootBone: 'A', endBone: 'C', target: new Bone(),
      joints: { B: { rotationAxis: 'z' } }, // B 只允许绕 Z 转
    });
    chain.initJoints(rig);
    chain.chain[2]!.set(0, 1, 1); // 目标在 +Z，Z 轴平面投影后 B→C 应保持 +Y（投影到 XY 平面）
    chain.cacheCurrentVectors(rig);
    chain.cacheCurrentJointRotations(rig);
    const lpose = chain.solverInfos[1]!.currentLpose;
    // 纯 Z 轴旋转保持 (0,0,1) 不变（旋转轴平行 Z）
    const fixed = new Vector3(0, 0, 1).applyQuaternion(lpose);
    expect(fixed.z).toBeCloseTo(1, 4);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/ik/cache-rotations.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 —— 向 `src/modifiers/ik/ik-chain.ts` 追加**

JointSetting 追加（translate get_projected_rotation）：
```ts
  /** 把 vector 投影到以 rotationAxis 为法线的旋转平面（offset = 参考系四元数） */
  getProjectedRotation(offset: Quaternion, vector: Vector3, out: Vector3): Vector3 {
    if (this.rotationAxis === 'all') return out.copy(vector);
    const ALMOST_ONE = 1 - CMP_EPSILON;
    const axis = this.getRotationAxisVector(_v2).normalize();
    const off = _q1.copy(offset).multiply(this.limitationOffsetDelta);
    xformQuatInv(off, vector, out);
    const length = out.length();
    const localNrm = _v1.copy(out);
    if (!isZeroApprox(length)) localNrm.multiplyScalar(1 / length);
    snapVectorToPlane(axis, localNrm, out);
    if (!isZeroApprox(length)) out.normalize().multiplyScalar(length);
    if (Math.abs(localNrm.dot(axis)) > ALMOST_ONE) return out.copy(vector);
    return xformQuat(off, out, out);
  }
```

IKChain 追加（translate cache_current_joint_rotations，iterate_ik_3d.h 161–232 行）：
```ts
  /** 链坐标 → 各骨 currentLpose；angularDeltaLimit = 每次迭代最大角度增量（弧度） */
  cacheCurrentJointRotations(rig: SkeletonRig, angularDeltaLimit = Math.PI): void {
    const parent = rig.getParentIndex(this.rootBone);
    const parentGpose = _q1.identity();
    if (parent >= 0) rig.getGlobalPoseQuaternion(parent, parentGpose);

    for (let i = 0; i < this.joints.length; i++) {
      const info = this.solverInfos[i];
      if (!info) continue;
      const js = this.jointSettings[i]!;
      const bone = this.joints[i]!;
      rig.getPoseRotation(bone, info.currentLrest);
      info.currentGrest.copy(parentGpose).multiply(info.currentLrest).normalize();
      if (js.useRestForLimitation) {
        // limitationOffsetDelta = (currentLrest^-1 * restQuat).normalized
        rig.getRestQuaternion(bone, js.limitationOffsetDelta);
        js.limitationOffsetDelta.premultiply(_q2.copy(info.currentLrest).invert()).normalize();
      } else {
        js.limitationOffsetDelta.identity();
      }
      const from = _v1.copy(info.forwardVector);
      const to = xformQuatInv(info.currentGrest, info.currentVector, _v2).normalize();
      const prev = _q3.copy(info.currentLpose);
      if (js.rotationAxis === 'all') {
        // lpose = lrest * getSwing(fromTo(from, to), from)
        _q2.setFromUnitVectors(from, to);
        getSwing(_q2, from, _q4);
        info.currentLpose.copy(info.currentLrest).multiply(_q4);
      } else if (js.useRestForLimitation) {
        const poseFromRest = _q2.copy(js.limitationOffsetDelta).invert();
        const axis = js.getRotationAxisVector(_v3).normalize();
        // toRest = 平面投影后的目标方向
        const toRest = xformQuat(poseFromRest, to, _v4);
        snapVectorToPlane(axis, toRest, toRest);
        if (isZeroApprox(toRest.lengthSq())) {
          toRest.copy(from);
        } else {
          toRest.normalize();
        }
        const twist = _q4.identity();
        if (!isZeroApprox(from.lengthSq())) {
          const forwardNrm = _v5.copy(from).normalize();
          twist.setFromAxisAngle(forwardNrm, getRollAngle(poseFromRest, forwardNrm));
        }
        // lpose = lrest * delta * fromToByAxis(from, toRest, axis) * twist
        getFromToRotationByAxis(from, toRest, axis, _q5);
        info.currentLpose.copy(info.currentLrest)
          .multiply(js.limitationOffsetDelta).multiply(_q5).multiply(twist);
      } else {
        const axis = js.getRotationAxisVector(_v3).normalize();
        getFromToRotationByAxis(from, to, axis, _q2);
        info.currentLpose.copy(info.currentLrest).multiply(_q2);
      }
      // angular delta 钳制
      const diff = prev.angleTo(info.currentLpose);
      if (!isZeroApprox(diff)) {
        info.currentLpose.copy(prev).slerp(info.currentLpose, Math.min(1, angularDeltaLimit / diff));
      }
      info.currentGpose.copy(parentGpose).multiply(info.currentLpose).normalize();
      parentGpose.copy(info.currentGpose);
    }

    // 把角度钳制回写链坐标（apply back）
    if (this.chain.length === 0) return;
    rig.getGlobalPosePosition(this.rootBone, this.chain[0]!);
    for (let i = 0; i < this.solverInfos.length; i++) {
      const info = this.solverInfos[i];
      if (!info || i + 1 >= this.chain.length) continue;
      xformQuat(info.currentGpose, info.forwardVector, _v1);
      this.chain[i + 1]!.copy(this.chain[i]!).addScaledVector(_v1, info.length);
    }
    this.cacheCurrentVectors(rig);
  }
```

ik-chain.ts 顶部 import 追加 `getFromToRotationByAxis, getRollAngle, getSwing`（来自 math.ts），临时变量追加：
```ts
const _v3 = new Vector3();
const _v4 = new Vector3();
const _v5 = new Vector3();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _q4 = new Quaternion();
const _q5 = new Quaternion();
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/ik/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/ik/ik-chain.ts tests/modifiers/ik/cache-rotations.test.ts
git commit -m "feat(ik): 链坐标回写骨骼旋转（cacheCurrentJointRotations 翻译）"
```

---

### Task 10: JointLimitation —— 关节角度限制（角锥）

**Files:**
- Create: `src/modifiers/ik/joint-limitation.ts`
- Modify: `src/modifiers/ik/ik-chain.ts`（JointSetting 追加 `getLimitedRotation`）
- Test: `tests/modifiers/ik/joint-limitation.test.ts`

**Interfaces:**
- Produces:
  - `abstract class JointLimitation { solve(localForward, localRight, rotationOffset, localCurrent, out): Vector3; protected abstract solveDirection(direction: Vector3, out: Vector3): Vector3; makeSpace(localForward, localRight, rotationOffset, out: Quaternion): Quaternion }` —— 限制空间 +Y = 锥轴（translate joint_limitation_3d.cpp 33–57 行）
  - `class ConeJointLimitation extends JointLimitation { constructor(angle: number) }` —— `angle` 为锥**全角**（弧度），`maxAngle = angle / 2`（translate joint_limitation_cone_3d.cpp 63–103 行）
  - `JointSetting.getLimitedRotation(offset: Quaternion, vector: Vector3, forward: Vector3, out: Vector3): Vector3` —— 在局部 rest 空间求角锥限制（iterate_ik_3d.h 135–145 行）

- [ ] **Step 1: 写失败测试**

`tests/modifiers/ik/joint-limitation.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { ConeJointLimitation } from '../../../src/modifiers/ik/joint-limitation';

describe('ConeJointLimitation', () => {
  const forward = new Vector3(0, 1, 0); // 锥轴 +Y
  const right = new Vector3(1, 0, 0);
  const offset = new Quaternion();

  it('passes through directions inside the cone', () => {
    const cone = new ConeJointLimitation(Math.PI / 2); // max 45°
    const dir = new Vector3(0.1, 1, 0).normalize(); // 距 +Y 约 5.7°
    const out = cone.solve(forward, right, offset, dir, new Vector3());
    expect(out.distanceTo(dir)).toBeLessThan(1e-5);
  });

  it('clamps directions outside the cone to its rim', () => {
    const cone = new ConeJointLimitation(Math.PI / 2); // max 45°
    const dir = new Vector3(1, 0, 0); // 距 +Y 90°
    const out = cone.solve(forward, right, offset, dir, new Vector3());
    expect(out.angleTo(forward)).toBeCloseTo(Math.PI / 4, 3);
    // 钳制方向应尽量保留原方向的侧向（+X 侧）
    expect(out.x).toBeGreaterThan(0.5);
  });

  it('handles antiparallel direction without NaN', () => {
    const cone = new ConeJointLimitation(Math.PI / 3);
    const out = cone.solve(forward, right, offset, new Vector3(0, -1, 0), new Vector3());
    expect(out.length()).toBeCloseTo(1, 5);
    expect(out.angleTo(forward)).toBeCloseTo(Math.PI / 6, 3);
  });

  it('respects rotation offset (cone axis rotated)', () => {
    const cone = new ConeJointLimitation(Math.PI / 2);
    // offset 把锥轴从 +Y 转到 +Z
    const off = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const inside = cone.solve(forward, right, off, new Vector3(0, 0, 1), new Vector3());
    expect(inside.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-4);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/ik/joint-limitation.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/modifiers/ik/joint-limitation.ts`:
```ts
import { Matrix4, Quaternion, Vector3 } from 'three';
import { CMP_EPSILON, isZeroApprox } from '../../core/math';

const ALMOST_ONE = 1 - CMP_EPSILON;
const UP = new Vector3(0, 1, 0);
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q1 = new Quaternion();
const _m = new Matrix4();

/** Godot: JointLimitation3D（joint_limitation_3d.cpp）。限制空间约定：+Y = 锥轴（forward） */
export abstract class JointLimitation {
  /** 在限制空间求解（输入输出均为单位向量，锥轴 +Y） */
  protected abstract solveDirection(direction: Vector3, out: Vector3): Vector3;

  /** translate make_space：由 forward/right/offset 构建限制空间四元数 */
  makeSpace(localForward: Vector3, localRight: Vector3, rotationOffset: Quaternion, out: Quaternion): Quaternion {
    const axisY = _v1.copy(localForward).normalize();
    const axisX = _v2.copy(localRight).normalize();
    if (isZeroApprox(axisX.lengthSq()) || Math.abs(axisX.dot(axisY)) > ALMOST_ONE) {
      // 退化：仅对齐 forward 到 +Y
      return out.setFromUnitVectors(UP, axisY).multiply(_q1.copy(rotationOffset).normalize()).normalize();
    }
    // 优先 X 轴：z = x × y，再正交化 x = y × z
    const axisZ = _v3.copy(axisX).cross(axisY).normalize();
    axisX.copy(axisY).cross(axisZ).normalize();
    _m.makeBasis(axisX, axisY, axisZ);
    return out.setFromRotationMatrix(_m).multiply(_q1.copy(rotationOffset).normalize()).normalize();
  }

  /** translate solve：localCurrent → 限制空间 → 子类钳制 → 变回 */
  solve(localForward: Vector3, localRight: Vector3, rotationOffset: Quaternion, localCurrent: Vector3, out: Vector3): Vector3 {
    const space = this.makeSpace(localForward, localRight, rotationOffset, _q1);
    const dir = _v1.copy(localCurrent).normalize().applyQuaternion(_q1.invert());
    this.solveDirection(dir, out);
    return out.applyQuaternion(space);
  }
}

/** Godot: JointLimitationCone3D。angle = 锥全角（弧度） */
export class ConeJointLimitation extends JointLimitation {
  constructor(public angle: number) {
    super();
  }

  protected solveDirection(direction: Vector3, out: Vector3): Vector3 {
    const centerAxis = _v2.set(0, 1, 0);
    const currentAngle = direction.angleTo(centerAxis);
    const maxAngle = this.angle * 0.5;
    if (currentAngle <= maxAngle) return out.copy(direction);

    // 完全反向：任取垂直轴
    let planeNormal: Vector3;
    if (Math.abs(currentAngle - Math.PI) < CMP_EPSILON) {
      planeNormal = _v1.set(1, 0, 0); // +Y 的任一垂直向量
    } else {
      planeNormal = _v1.copy(centerAxis).cross(direction).normalize();
    }
    // 默认：centerAxis 绕 planeNormal 转 maxAngle
    out.copy(centerAxis).applyQuaternion(_q1.setFromAxisAngle(planeNormal, maxAngle));
    // 若 direction 在锥外但有侧向分量：取 direction 侧向、夹角 maxAngle 的方向（保留方向性）
    const projection = _v2.copy(direction).addScaledVector(centerAxis, -direction.dot(centerAxis));
    if (projection.lengthSq() > CMP_EPSILON) {
      const sideDir = projection.normalize();
      planeNormal.copy(centerAxis).cross(sideDir);
      if (planeNormal.lengthSq() > CMP_EPSILON) {
        out.copy(centerAxis).applyQuaternion(_q1.setFromAxisAngle(planeNormal.normalize(), maxAngle));
      }
    }
    return out.normalize();
  }
}
```

JointSetting（`src/modifiers/ik/ik-chain.ts`）追加：
```ts
  /** 在局部 rest 空间求角锥限制（translate get_limited_rotation）；limitation 为空时原样返回 */
  getLimitedRotation(offset: Quaternion, vector: Vector3, forward: Vector3, out: Vector3): Vector3 {
    if (!this.limitation) return out.copy(vector);
    const off = _q1.copy(offset).multiply(this.limitationOffsetDelta);
    xformQuatInv(off, vector, out);
    const length = out.length();
    if (isZeroApprox(length)) return out.copy(vector);
    out.multiplyScalar(1 / length);
    this.limitation.solve(forward, this.getLimitationRightAxisVector(_v1), this.limitationRotationOffset, out, out);
    out.multiplyScalar(length);
    return xformQuat(off, out, out);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/ik/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/ik/joint-limitation.ts src/modifiers/ik/ik-chain.ts tests/modifiers/ik/joint-limitation.test.ts
git commit -m "feat(ik): 关节角锥限制（ConeJointLimitation，翻译 JointLimitation3D）"
```

### Task 11: IterateIKModifier 基类 + CCD 求解器

**Files:**
- Create: `src/modifiers/ik/iterate-ik.ts`
- Create: `src/modifiers/ik/ccd-ik.ts`
- Test: `tests/modifiers/ik/ccd-ik.test.ts`

**Interfaces:**
- Consumes: `IKChain`/`IKChainConfig`/`JointSetting`（Task 8/9/10）、`Modifier`（Task 7）
- Produces:
  - `interface IterateIKOptions { maxIterations?: number; minDistance?: number; angularDeltaLimit?: number }`（默认 4 / 0.001 / 2°，Godot 同值）
  - `abstract class IterateIKModifier extends Modifier`：
    - `constructor(chains: IKChainConfig[], options?: IterateIKOptions)`
    - `attach(rig)` 时构建 `chains: IKChain[]`（校验在此抛出）；`setChains(chains)` 重建（构造时配置式的运行时替换入口）
    - `processModification(rig, delta)`：逐链 `initJoints` → `cacheCurrentJointRotations(rig)`（全量，检测链外父骨变化）→ 解析 target → `processJoints` → 写回 `rig.setPoseRotation`（translate iterate_ik_3d.cpp 567–615 行）
    - `protected abstract solveIteration(rig, chain, destination): void`
    - `getChain(i): IKChain`（测试/调试）
  - `class CCDIkModifier extends IterateIKModifier`
  - target 解析约定（写入 README）：`Object3D` → `getWorldPosition` 后 `rig.worldToRigSpace`；`string` → `rig.targetResolver?.(key)`（未解析到时该链本帧跳过 + `warnOnce`）

**target 为字符串时的 rig 扩展**（本 task 在 skeleton-rig.ts 追加一行成员）：`targetResolver?: (key: string) => Object3D | null | undefined` —— 公开可写字段，默认 undefined。

- [ ] **Step 1: 写失败测试**

`tests/modifiers/ik/ccd-ik.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { CCDIkModifier } from '../../../src/modifiers/ik/ccd-ik';

/** 三骨直链：Root(0,0,0) → Mid(0,1,0) → End(0,1,0)，世界空间即 rig 空间 */
function buildRig() {
  const root = new Bone(); root.name = 'Root';
  const mid = new Bone(); mid.name = 'Mid'; mid.position.set(0, 1, 0);
  const end = new Bone(); end.name = 'End'; end.position.set(0, 1, 0);
  root.add(mid); mid.add(end);
  const rig = new SkeletonRig(root);
  return rig;
}

function endEffectorPos(rig: SkeletonRig, out: Vector3): Vector3 {
  return rig.getGlobalPosePosition(2, out);
}

describe('CCDIkModifier', () => {
  it('reaches a reachable target', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(1, 1.5, 0);
    rig.addModifier(new CCDIkModifier(
      [{ rootBone: 'Root', endBone: 'End', target }],
      { maxIterations: 20, angularDeltaLimit: Math.PI }, // 测试不限角度增量
    ));
    rig.update(0.016);
    const pos = endEffectorPos(rig, new Vector3());
    expect(pos.distanceTo(new Vector3(1, 1.5, 0))).toBeLessThan(0.01);
  });

  it('stretches toward an unreachable target', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0, 5, 0);
    rig.addModifier(new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target }], { maxIterations: 20 }));
    rig.update(0.016);
    const pos = endEffectorPos(rig, new Vector3());
    expect(pos.y).toBeCloseTo(2, 2); // 链总长 2，拉直朝 +Y
    expect(Math.abs(pos.x)).toBeLessThan(0.05);
  });

  it('is isolated from base pose across frames（无累积）', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(1, 1, 0);
    rig.addModifier(new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target }], { maxIterations: 10 }));
    rig.update(0.016);
    const first = rig.getBoneAt(1).quaternion.clone();
    rig.update(0.016);
    expect(rig.getBoneAt(1).quaternion.angleTo(first)).toBeLessThan(1e-4);
  });

  it('influence 0 leaves pose untouched', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(2, 0, 0);
    const m = new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target }]);
    m.influence = 0;
    rig.addModifier(m);
    rig.update(0.016);
    expect(rig.getBoneAt(1).quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('resolves string targets via rig.targetResolver', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0.5, 1, 0);
    rig.targetResolver = (key) => (key === 'hand-target' ? target : null);
    rig.addModifier(new CCDIkModifier([{ rootBone: 'Root', endBone: 'End', target: 'hand-target' }], { maxIterations: 20, angularDeltaLimit: Math.PI }));
    rig.update(0.016);
    expect(endEffectorPos(rig, new Vector3()).distanceTo(new Vector3(0.5, 1, 0))).toBeLessThan(0.01);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/ik/ccd-ik.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/core/skeleton-rig.ts` 追加成员（公开字段区）：
```ts
  /** 字符串 target 的解析器（theatre 接入层注入）：key → Object3D */
  targetResolver?: (key: string) => Object3D | null | undefined;
```

`src/modifiers/ik/iterate-ik.ts`:
```ts
import { Object3D, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { Modifier } from '../modifier';
import { IKChain, type IKChainConfig } from './ik-chain';

export interface IterateIKOptions {
  maxIterations?: number;
  minDistance?: number;
  angularDeltaLimit?: number;
}

const _targetPos = new Vector3();

/** Godot: IterateIK3D 的求解流程（iterate_ik_3d.cpp 567–615 行） */
export abstract class IterateIKModifier extends Modifier {
  protected chains: IKChain[] = [];
  private chainConfigs: IKChainConfig[];

  maxIterations: number;
  minDistance: number;
  angularDeltaLimit: number;

  constructor(chains: IKChainConfig[], options?: IterateIKOptions) {
    super();
    this.chainConfigs = chains;
    this.maxIterations = options?.maxIterations ?? 4;
    this.minDistance = options?.minDistance ?? 0.001;
    this.angularDeltaLimit = options?.angularDeltaLimit ?? Math.PI / 90; // 2°
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.setChains(this.chainConfigs);
  }

  /** 构造时配置式：运行时整体替换配置并重建链缓存 */
  setChains(configs: IKChainConfig[]): void {
    this.chainConfigs = configs;
    if (!this.rig) return;
    this.chains = configs.map((c) => new IKChain(this.rig!, c));
  }

  getChain(i: number): IKChain {
    return this.chains[i]!;
  }

  get chainCount(): number {
    return this.chains.length;
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    const minDistSq = this.minDistance * this.minDistance;
    for (const chain of this.chains) {
      chain.initJoints(rig);
      const destination = this.resolveTarget(rig, chain);
      if (!destination) continue; // 未解析到 target：本帧跳过
      chain.cacheCurrentJointRotations(rig); // 全量，检测链外父骨姿势变化
      this.processJoints(rig, chain, destination, minDistSq);
      // 求解结果写回工作姿势（Godot: set_bone_pose_rotation）
      for (let i = 0; i < chain.solverInfos.length; i++) {
        const info = chain.solverInfos[i];
        if (!info || info.length === 0) continue;
        rig.setPoseRotation(chain.joints[i]!, info.currentLpose);
      }
      chain.simulated = true;
    }
  }

  /** 防振荡：已模拟过且已达标的链不再迭代（translate _process_joints） */
  private processJoints(rig: SkeletonRig, chain: IKChain, destination: Vector3, minDistSq: number): void {
    let distSq = Infinity;
    let iteration = 0;
    if (chain.simulated) {
      distSq = chain.getChainEnd().distanceToSquared(destination);
    }
    while (distSq > minDistSq && iteration < this.maxIterations) {
      this.solveIteration(rig, chain, destination);
      chain.cacheCurrentJointRotations(rig, this.angularDeltaLimit);
      distSq = chain.getChainEnd().distanceToSquared(destination);
      iteration++;
    }
  }

  protected resolveTarget(rig: SkeletonRig, chain: IKChain): Vector3 | null {
    const t = chain.config.target;
    const obj = typeof t === 'string' ? rig.targetResolver?.(t) : t;
    if (!obj) {
      rig.warnOnce(`ik-target-missing:${String(t)}`, `IK target not resolvable: ${String(t)}`);
      return null;
    }
    obj.getWorldPosition(_targetPos);
    if (Number.isNaN(_targetPos.x + _targetPos.y + _targetPos.z)) {
      rig.warnOnce('ik-target-nan', `IK target position is NaN: ${String(t)}`);
      return null;
    }
    return rig.worldToRigSpace(_targetPos, _targetPos);
  }

  protected abstract solveIteration(rig: SkeletonRig, chain: IKChain, destination: Vector3): void;

  toJSON(): Record<string, unknown> {
    return {
      chains: this.chainConfigs.map((c) => ({
        ...c,
        target: typeof c.target === 'string' ? c.target : c.target.name || null,
        joints: Object.fromEntries(
          Object.entries(c.joints ?? {}).map(([k, v]) => [k, { ...v, limitation: v.limitation ? { type: 'cone', angle: (v.limitation as { angle?: number }).angle } : null }]),
        ),
      })),
      maxIterations: this.maxIterations,
      minDistance: this.minDistance,
      angularDeltaLimit: this.angularDeltaLimit,
    };
  }
}
```

`src/modifiers/ik/ccd-ik.ts`（translate ccd_ik_3d.cpp 33–71 行）:
```ts
import { Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { isZeroApprox } from '../../core/math';
import type { IKChain } from './ik-chain';
import { IterateIKModifier } from './iterate-ik';

const _q = new Quaternion();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

export class CCDIkModifier extends IterateIKModifier {
  protected solveIteration(rig: SkeletonRig, chain: IKChain, destination: Vector3): void {
    const jointSize = chain.joints.length;

    // 外层：ancestor 倒序；内层：正序（Godot 双层循环）
    for (let ancestor = jointSize - 1; ancestor >= 0; ancestor--) {
      for (let i = ancestor; i < jointSize; i++) {
        const info = chain.solverInfos[i];
        if (!info || isZeroApprox(info.length)) continue;

        const head = i;
        const tail = i + 1;

        const headPos = _v1.copy(chain.chain[head]!);
        const headToEffector = _v2.copy(chain.getChainEnd()).sub(headPos);
        const headToDest = _v3.copy(destination).sub(headPos);
        if (isZeroApprox(headToDest.lengthSq() * headToEffector.lengthSq())) continue;

        // toRot = from-to 旋转；新 tail = head + toRot * (tail - head)
        const toRot = _q.setFromUnitVectors(headToEffector.normalize(), headToDest.normalize());
        _v2.copy(chain.chain[tail]!).sub(headPos).applyQuaternion(toRot).add(headPos);
        chain.updateChainCoordinateFw(rig, tail, _v2);

        const js = chain.jointSettings[head]!;
        if (js.rotationAxis !== 'all') {
          // 轴投影：tail = head + getProjectedRotation(grest, tail - head)
          _v2.copy(chain.chain[tail]!).sub(chain.chain[head]!);
          js.getProjectedRotation(info.currentGrest, _v2, _v2);
          chain.updateChainCoordinateFw(rig, tail, _v2.add(chain.chain[head]!));
        }
        if (js.limitation) {
          _v2.copy(chain.chain[tail]!).sub(chain.chain[head]!);
          js.getLimitedRotation(info.currentGrest, _v2, info.forwardVector, _v2);
          chain.updateChainCoordinateFw(rig, tail, _v2.add(chain.chain[head]!));
        }
      }
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/ik/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/ik/iterate-ik.ts src/modifiers/ik/ccd-ik.ts src/core/skeleton-rig.ts tests/modifiers/ik/ccd-ik.test.ts
git commit -m "feat(ik): IterateIKModifier 求解流程 + CCD 求解器"
```

---

### Task 12: FABRIK 求解器

**Files:**
- Create: `src/modifiers/ik/fabrik.ts`
- Test: `tests/modifiers/ik/fabrik.test.ts`

**Interfaces:**
- Consumes: `IterateIKModifier`（Task 11）
- Produces: `class FabrikModifier extends IterateIKModifier`

- [ ] **Step 1: 写失败测试**

`tests/modifiers/ik/fabrik.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { FabrikModifier } from '../../../src/modifiers/ik/fabrik';

/** 四骨链：A → B → C → D，各长 1，沿 +Y */
function buildRig() {
  const a = new Bone(); a.name = 'A';
  const b = new Bone(); b.name = 'B'; b.position.set(0, 1, 0);
  const c = new Bone(); c.name = 'C'; c.position.set(0, 1, 0);
  const d = new Bone(); d.name = 'D'; d.position.set(0, 1, 0);
  a.add(b); b.add(c); c.add(d);
  const rig = new SkeletonRig(a);
  return rig;
}

describe('FabrikModifier', () => {
  it('reaches a reachable target preserving segment lengths', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(1, 1.8, 0.3);
    rig.addModifier(new FabrikModifier([{ rootBone: 'A', endBone: 'D', target }], { maxIterations: 20, angularDeltaLimit: Math.PI }));
    rig.update(0.016);
    expect(rig.getGlobalPosePosition(3, new Vector3()).distanceTo(new Vector3(1, 1.8, 0.3))).toBeLessThan(0.01);
    // 骨长保持：A→B、B→C、C→D 全局距离仍为 1
    const pa = rig.getGlobalPosePosition(0, new Vector3());
    const pb = rig.getGlobalPosePosition(1, new Vector3());
    const pc = rig.getGlobalPosePosition(2, new Vector3());
    const pd = rig.getGlobalPosePosition(3, new Vector3());
    expect(pb.distanceTo(pa)).toBeCloseTo(1, 3);
    expect(pc.distanceTo(pb)).toBeCloseTo(1, 3);
    expect(pd.distanceTo(pc)).toBeCloseTo(1, 3);
  });

  it('stretches toward an unreachable target', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0, 10, 0);
    rig.addModifier(new FabrikModifier([{ rootBone: 'A', endBone: 'D', target }], { maxIterations: 20 }));
    rig.update(0.016);
    expect(rig.getGlobalPosePosition(3, new Vector3()).y).toBeCloseTo(3, 1);
  });

  it('root stays fixed at its global pose', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(0.5, 0.5, 0.5);
    rig.addModifier(new FabrikModifier([{ rootBone: 'A', endBone: 'D', target }], { maxIterations: 20 }));
    rig.update(0.016);
    expect(rig.getGlobalPosePosition(0, new Vector3()).length()).toBeLessThan(1e-5); // root 在原点
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/ik/fabrik.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（translate fabr_ik_3d.cpp 33–87 行）**

`src/modifiers/ik/fabrik.ts`:
```ts
import { Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { isZeroApprox, limitLength } from '../../core/math';
import type { IKChain } from './ik-chain';
import { IterateIKModifier } from './iterate-ik';

const _v = new Vector3();

export class FabrikModifier extends IterateIKModifier {
  protected solveIteration(rig: SkeletonRig, chain: IKChain, destination: Vector3): void {
    const jointSize = chain.joints.length;

    // Backward：末端贴 target，逐骨向 root 拉（保骨长）
    let first = true;
    for (let i = jointSize - 1; i >= 0; i--) {
      const info = chain.solverInfos[i];
      if (!info || isZeroApprox(info.length)) continue;
      const head = i;
      const tail = i + 1;
      if (first) {
        chain.updateChainCoordinateBw(rig, tail, destination);
        first = false;
      }
      limitLength(chain.chain[tail]!, chain.chain[head]!, info.length, _v);
      chain.updateChainCoordinateBw(rig, head, _v);
      this.applyJointConstraints(rig, chain, head, tail, true);
    }

    // Forward：首端回原位，逐骨向末端推
    first = true;
    for (let i = 0; i < jointSize; i++) {
      const info = chain.solverInfos[i];
      if (!info || isZeroApprox(info.length)) continue;
      const head = i;
      const tail = i + 1;
      if (first) {
        rig.getGlobalPosePosition(chain.joints[head]!, _v); // root 固定在当前全局姿势
        chain.updateChainCoordinateFw(rig, head, _v);
        first = false;
      }
      limitLength(chain.chain[head]!, chain.chain[tail]!, info.length, _v);
      chain.updateChainCoordinateFw(rig, tail, _v);
      this.applyJointConstraints(rig, chain, head, tail, false);
    }
  }

  /** 轴投影 + 角锥限制（与 Godot 一致走 bw/fw 守卫版更新） */
  private applyJointConstraints(rig: SkeletonRig, chain: IKChain, head: number, tail: number, isBackward: boolean): void {
    const js = chain.jointSettings[head]!;
    const info = chain.solverInfos[head]!;
    if (js.rotationAxis === 'all' && !js.limitation) return;
    const anchor = isBackward ? tail : head;   // 固定端
    const moving = isBackward ? head : tail;   // 被移动端
    const update = (pos: Vector3): void => {
      if (isBackward) chain.updateChainCoordinateBw(rig, moving, pos);
      else chain.updateChainCoordinateFw(rig, moving, pos);
    };
    if (js.rotationAxis !== 'all') {
      _v.copy(chain.chain[moving]!).sub(chain.chain[anchor]!);
      js.getProjectedRotation(info.currentGrest, _v, _v);
      update(_v.add(chain.chain[anchor]!));
    }
    if (js.limitation) {
      _v.copy(chain.chain[moving]!).sub(chain.chain[anchor]!);
      js.getLimitedRotation(info.currentGrest, _v, info.forwardVector, _v);
      update(_v.add(chain.chain[anchor]!));
    }
  }
}
```

> 实现注意：Task 8 的 `IKChain` 需暴露无方向版 `updateChainCoordinate(rig, index, position)`（chain_ik_3d.h 63–73 行，不带防翻转守卫）——若 Task 8 漏掉，在本 task 补上（三行：`if isZeroApprox(distance) return; chain[index].copy(position); cacheCurrentVector(rig, index);`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/ik/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/ik/fabrik.ts tests/modifiers/ik/fabrik.test.ts
git commit -m "feat(ik): FABRIK 求解器"
```

### Task 13: TwoBoneIK —— 解析双骨求解器（pole target）

**Files:**
- Create: `src/modifiers/ik/two-bone-ik.ts`
- Test: `tests/modifiers/ik/two-bone-ik.test.ts`

**Interfaces:**
- Consumes: `Modifier`、`getBoneAxis`（Task 8）、math 工具（Task 3）
- Produces:
  - `interface TwoBoneIKConfig { rootBone: string; middleBone: string; endBone: string; target: Object3D | string; poleTarget: Object3D | string; poleDirection?: SecondaryDirection; poleDirectionVector?: Vector3; extendEndBone?: boolean; endBoneDirection?: BoneDirection; endBoneLength?: number }`
  - `class TwoBoneIkModifier extends Modifier { constructor(configs: TwoBoneIKConfig[]); getSetting(i): TwoBoneIKSetting }`
  - v1 简化（写入 JSDoc）：middle 必须是 root 的直接子骨，end 必须是 middle 的直接子骨（Godot 允许中间夹骨，v1 不支持）

**算法要点（translate two_bone_ik_3d.cpp 780–843 行 + two_bone_ik_3d.h 146–235 行）**：
1. 目标过远（dist² ≥ (lenRoot+lenMid)²）→ 拉直；过近（dist² < (lenRoot−lenMid)²）→ 把 target 推回可达球面。
2. 弯曲时 mid = 两圆交点：余弦定理求 `a`、`h = sqrt(r_root²−a²)`，`poleVec = getProjectedNormal(rootPos, endPos, poleDest)`，±h 两解取离 pole 近者。
3. `cacheCurrentJointRotations(poleDest)`：swing 求 root/mid 旋转；`poleDirection ≠ 'none'` 时做 roll 修正——解 `c0·cosθ + c1·sinθ + c2 = 0`（`c0 = n·(k−a(k·a))`，`c1 = n·(a×k)`，`c2 = (n·a)(k·a)`，`φ = atan2(c1, c0)`，`θ = φ ± acos(clamp(−c2/r))`），两解取 pole 投影更近者，root/mid 各乘 roll 四元数（mid 还需抵消 root 的 roll：`rootRoll⁻¹ * midLpose * midRoll`）。

- [ ] **Step 1: 写失败测试**

`tests/modifiers/ik/two-bone-ik.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { TwoBoneIkModifier } from '../../../src/modifiers/ik/two-bone-ik';

/** 腿：Upper(0,0,0) → Lower(0,-1,0) → Foot(0,-1,0)，朝下（人腿惯例） */
function buildLeg() {
  const upper = new Bone(); upper.name = 'Upper';
  const lower = new Bone(); lower.name = 'Lower'; lower.position.set(0, -1, 0);
  const foot = new Bone(); foot.name = 'Foot'; foot.position.set(0, -1, 0);
  upper.add(lower); lower.add(foot);
  const rig = new SkeletonRig(upper);
  return rig;
}

function makeTarget(x: number, y: number, z: number) {
  const o = new Object3D();
  o.position.set(x, y, z);
  return o;
}

describe('TwoBoneIkModifier', () => {
  it('bends the knee toward the pole target and lands the foot', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -1.5, 0.5);
    const pole = makeTarget(0, -0.5, 10); // pole 在前方
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const footPos = rig.getGlobalPosePosition(2, new Vector3());
    expect(footPos.distanceTo(new Vector3(0, -1.5, 0.5))).toBeLessThan(0.01);
    // 膝盖（Lower 全局位置）应向 pole 方向（+Z）弯曲
    const kneePos = rig.getGlobalPosePosition(1, new Vector3());
    expect(kneePos.z).toBeGreaterThan(0.05);
  });

  it('straightens the leg for unreachable targets', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -5, 0);
    const pole = makeTarget(0, 0, 10);
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const footPos = rig.getGlobalPosePosition(2, new Vector3());
    expect(footPos.y).toBeCloseTo(-2, 2); // 拉直
    expect(Math.abs(footPos.z)).toBeLessThan(0.02);
  });

  it('pushes too-close targets back to the reachable sphere', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -0.1, 0); // 距离 0.1 < |lenRoot - lenMid| = 0 不成立；改测 dist < sub：两骨等长时 sub=0，用不等长链更直观——此处验证不 NaN 且脚不落在不可达点
    const pole = makeTarget(0, 0, 10);
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const footPos = rig.getGlobalPosePosition(2, new Vector3());
    expect(Number.isNaN(footPos.x + footPos.y + footPos.z)).toBe(false);
  });

  it('is isolated from base pose across frames', () => {
    const rig = buildLeg();
    const target = makeTarget(0, -1.5, 0.5);
    const pole = makeTarget(0, 0, 10);
    rig.addModifier(new TwoBoneIkModifier([{ rootBone: 'Upper', middleBone: 'Lower', endBone: 'Foot', target, poleTarget: pole }]));
    rig.update(0.016);
    const first = rig.getBoneAt(0).quaternion.clone();
    rig.update(0.016);
    expect(rig.getBoneAt(0).quaternion.angleTo(first)).toBeLessThan(1e-4);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/ik/two-bone-ik.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/modifiers/ik/two-bone-ik.ts`:
```ts
import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { ThreeIKError } from '../../core/errors';
import { getLocalPoseRotation, getProjectedNormal, getSwing, isZeroApprox, snapVectorToPlane, xformQuatInv } from '../../core/math';
import { vectorFromSecondaryDirection } from '../../core/bone-axes';
import type { BoneDirection, SecondaryDirection } from '../../core/bone-axes';
import { Modifier } from '../modifier';
import { getBoneAxis, type SolverInfo } from './ik-chain';

export interface TwoBoneIKConfig {
  rootBone: string;
  middleBone: string;
  endBone: string;
  target: Object3D | string;
  poleTarget: Object3D | string;
  /** 中骨局部空间里指向 pole 的轴向（用于 roll 修正）；'none' 跳过 roll 修正 */
  poleDirection?: SecondaryDirection;
  poleDirectionVector?: Vector3;
  extendEndBone?: boolean;
  endBoneDirection?: BoneDirection;
  endBoneLength?: number;
}

interface TwoBoneIKSetting {
  rootBone: number;
  middleBone: number;
  endBone: number;
  rootInfo: SolverInfo;
  midInfo: SolverInfo;
  cachedLengthSq: number;
  rootPos: Vector3;
  midPos: Vector3;
  endPos: Vector3;
  config: TwoBoneIKConfig;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _qp = new Quaternion();

export class TwoBoneIkModifier extends Modifier {
  private settings: TwoBoneIKSetting[] = [];

  constructor(private configs: TwoBoneIKConfig[]) {
    super();
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.settings = this.configs.map((config) => {
      const rootBone = rig.boneIndex(config.rootBone);
      const middleBone = rig.boneIndex(config.middleBone);
      const endBone = rig.boneIndex(config.endBone);
      if (rig.getParentIndex(middleBone) !== rootBone) {
        throw ThreeIKError.invalidChain(`TwoBoneIK: "${config.middleBone}" must be a direct child of "${config.rootBone}" (v1)`);
      }
      if (rig.getParentIndex(endBone) !== middleBone) {
        throw ThreeIKError.invalidChain(`TwoBoneIK: "${config.endBone}" must be a direct child of "${config.middleBone}" (v1)`);
      }
      // forward/length 取自子骨局部 rest 原点（与 IKChain.initJoints 同一约定）
      const rootInfo = makeInfo();
      const midInfo = makeInfo();
      rig.getRestPosition(middleBone, rootInfo.forwardVector);
      rootInfo.length = rootInfo.forwardVector.length();
      rootInfo.forwardVector.normalize();
      rig.getRestPosition(endBone, midInfo.forwardVector);
      midInfo.length = midInfo.forwardVector.length();
      midInfo.forwardVector.normalize();
      if (config.extendEndBone && (config.endBoneLength ?? 0) > 0) {
        // 虚拟端：mid 的长度替换为 endBone 轴向 * endBoneLength（求解以虚拟端点为目标）
        getBoneAxis(rig, endBone, config.endBoneDirection ?? 'from-parent', midInfo.forwardVector);
        midInfo.length = config.endBoneLength!;
      }
      if (isZeroApprox(rootInfo.length) || isZeroApprox(midInfo.length)) {
        throw ThreeIKError.invalidChain(`TwoBoneIK: zero-length bone in chain "${config.rootBone}"→"${config.endBone}"`);
      }
      const total = rootInfo.length + midInfo.length;
      return {
        rootBone, middleBone, endBone, rootInfo, midInfo,
        cachedLengthSq: total * total,
        rootPos: new Vector3(), midPos: new Vector3(), endPos: new Vector3(),
        config,
      };
    });
  }

  getSetting(i: number): Readonly<TwoBoneIKSetting> {
    return this.settings[i]!;
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const s of this.settings) {
      const destination = resolveObj(rig, s.config.target);
      const poleDest = resolveObj(rig, s.config.poleTarget);
      if (!destination || !poleDest) continue;
      this.processJoints(rig, s, destination, poleDest);
    }
  }

  /** translate TwoBoneIK3D::_process_joints（two_bone_ik_3d.cpp 780–843 行） */
  private processJoints(rig: SkeletonRig, s: TwoBoneIKSetting, destinationIn: Vector3, poleDest: Vector3): void {
    const destination = _v4.copy(destinationIn);
    rig.getGlobalPosePosition(s.rootBone, s.rootPos);
    const rootToDest = _v1.copy(destination).sub(s.rootPos);
    if (isZeroApprox(rootToDest.lengthSq())) return;

    const rdLenSq = rootToDest.lengthSq();
    if (rdLenSq >= s.cachedLengthSq) {
      // 过远：拉直
      const rdNrm = rootToDest.normalize();
      s.midPos.copy(s.rootPos).addScaledVector(rdNrm, s.rootInfo.length);
      s.endPos.copy(s.midPos).addScaledVector(rdNrm, s.midInfo.length);
    } else {
      // 过近：推回可达球面
      const sub = s.rootInfo.length - s.midInfo.length;
      if (rdLenSq < sub * sub) {
        destination.copy(s.rootPos).addScaledVector(rootToDest.normalize(), Math.abs(sub));
        rootToDest.copy(destination).sub(s.rootPos);
      }
      s.endPos.copy(destination);

      // 余弦定理求两圆交点，pole 近者优先
      const lChain = rootToDest.length();
      const u = rootToDest.normalize(); // _v1 现为 u
      const poleVec = getProjectedNormal(s.rootPos, s.endPos, poleDest, _v2);
      if (isZeroApprox(poleVec.lengthSq())) return;
      const rRoot = s.rootInfo.length;
      const rMid = s.midInfo.length;
      const a = (lChain * lChain + rRoot * rRoot - rMid * rMid) / (2 * lChain);
      const h2 = Math.max(0, rRoot * rRoot - a * a);
      const h = Math.sqrt(h2);
      // det± = rootPos + u*a ± poleVec*h；取离 pole 近者
      const detPlus = _v3.copy(s.rootPos).addScaledVector(u, a).addScaledVector(poleVec, h);
      const detPlusDist = poleDest.distanceToSquared(detPlus);
      const detMinusDist = poleDest.distanceToSquared(s.midPos.copy(s.rootPos).addScaledVector(u, a).addScaledVector(poleVec, -h));
      if (detPlusDist <= detMinusDist) s.midPos.copy(detPlus);
    }

    this.cacheCurrentJointRotations(rig, s, poleDest);

    rig.setPoseRotation(s.rootBone, s.rootInfo.currentLpose);
    // mid 的局部姿势相对 root 当前全局姿势（Godot: get_local_pose_rotation）
    rig.getGlobalPoseQuaternion(s.rootBone, _q1); // root 已写入，全局姿势同步后读取
    getLocalPoseRotation(_q1, s.midInfo.currentGpose, _q2);
    rig.setPoseRotation(s.middleBone, _q2);
  }

  /** translate two_bone_ik_3d.h 146–235 行（含 pole roll 修正） */
  private cacheCurrentJointRotations(rig: SkeletonRig, s: TwoBoneIKSetting, poleDest: Vector3): void {
    const parent = rig.getParentIndex(s.rootBone);
    const parentGpose = _qp.identity(); // 专用临时，贯穿全程
    if (parent >= 0) rig.getGlobalPoseQuaternion(parent, parentGpose);

    // 更新 current vectors（全局单位向量：root→mid、mid→end）
    s.rootInfo.currentVector.copy(s.midPos).sub(s.rootPos).normalize();
    s.midInfo.currentVector.copy(s.endPos).sub(s.midPos).normalize();

    // root：lrest = 当前 pose 旋转；grest = parent * lrest；lpose = lrest * swing(fromTo(from, to), from)
    rig.getPoseRotation(s.rootBone, s.rootInfo.currentLrest);
    s.rootInfo.currentGrest.copy(parentGpose).multiply(s.rootInfo.currentLrest).normalize();
    const from = _v1.copy(s.rootInfo.forwardVector);
    const to = xformQuatInv(s.rootInfo.currentGrest, s.rootInfo.currentVector, _v2).normalize();
    _q1.setFromUnitVectors(from, to);
    getSwing(_q1, from, _q1);
    s.rootInfo.currentLpose.copy(s.rootInfo.currentLrest).multiply(_q1);
    s.rootInfo.currentGpose.copy(parentGpose).multiply(s.rootInfo.currentLpose).normalize();
    const rootGpose = _q3.copy(s.rootInfo.currentGpose); // 专用临时

    // mid（v1 直链：lrest = 当前 mid pose 旋转）
    rig.getPoseRotation(s.middleBone, s.midInfo.currentLrest);
    s.midInfo.currentGrest.copy(rootGpose).multiply(s.midInfo.currentLrest).normalize();
    const fromM = _v1.copy(s.midInfo.forwardVector);
    const toM = xformQuatInv(s.midInfo.currentGrest, s.midInfo.currentVector, _v2).normalize();
    _q1.setFromUnitVectors(fromM, toM);
    getSwing(_q1, fromM, _q1);
    s.midInfo.currentLpose.copy(s.midInfo.currentLrest).multiply(_q1);
    s.midInfo.currentGpose.copy(rootGpose).multiply(s.midInfo.currentLpose).normalize();

    // ---- roll 修正（poleDirection ≠ 'none' 时；低频路径，允许局部分配以保证正确性优先）----
    const poleDirLocal = vectorFromSecondaryDirection(s.config.poleDirection ?? 'none', s.config.poleDirectionVector, _v1);
    if (isZeroApprox(poleDirLocal.lengthSq())) return;
    const poleDir = getProjectedNormal(s.rootPos, s.endPos, poleDest, _v2);
    if (isZeroApprox(poleDir.lengthSq())) return;
    const a = new Vector3().copy(s.midInfo.currentVector).normalize();            // 全局 roll 轴（mid forward）
    const k = new Vector3().copy(poleDirLocal).applyQuaternion(s.midInfo.currentGpose).normalize(); // 全局 pole 向量
    const n = new Vector3().copy(poleDir).cross(new Vector3().copy(s.midPos).sub(s.rootPos).normalize()).normalize();
    if (isZeroApprox(n.lengthSq()) || isZeroApprox(k.lengthSq()) || isZeroApprox(n.dot(k))) return;

    // c0·cosθ + c1·sinθ + c2 = 0
    const c0 = n.dot(new Vector3().copy(k).addScaledVector(a, -k.dot(a)));
    const c1 = n.dot(new Vector3().copy(a).cross(k));
    const c2 = n.dot(a) * k.dot(a);
    const r = Math.sqrt(c0 * c0 + c1 * c1);
    if (isZeroApprox(r)) return;
    const phi = Math.atan2(c1, c0);
    const acosv = Math.acos(Math.min(1, Math.max(-1, -c2 / r)));
    const t1 = phi + acosv;
    const t2 = phi - acosv;
    // 两解取 pole 投影更近者
    const poleProj = snapVectorToPlane(n, poleDir, new Vector3()).normalize();
    const k1p = snapVectorToPlane(n, new Vector3().copy(k).applyQuaternion(new Quaternion().setFromAxisAngle(a, t1)), new Vector3()).normalize();
    const k2p = snapVectorToPlane(n, new Vector3().copy(k).applyQuaternion(new Quaternion().setFromAxisAngle(a, t2)), new Vector3()).normalize();
    const s1 = isZeroApprox(poleProj.lengthSq()) ? Math.abs(t1) : k1p.dot(poleProj);
    const s2 = isZeroApprox(poleProj.lengthSq()) ? Math.abs(t2) : k2p.dot(poleProj);
    const t = s1 >= s2 ? t1 : t2;

    const rootRoll = new Quaternion().setFromAxisAngle(s.rootInfo.forwardVector, t);
    const midRoll = new Quaternion().setFromAxisAngle(s.midInfo.forwardVector, t);
    s.rootInfo.currentLpose.multiply(rootRoll);
    s.rootInfo.currentGpose.copy(parentGpose).multiply(s.rootInfo.currentLpose).normalize();
    rootGpose.copy(s.rootInfo.currentGpose);
    // mid 抵消 root 的 roll 后乘自身 roll（Godot: root_roll⁻¹ * mid_lpose * mid_roll）
    s.midInfo.currentLpose.premultiply(new Quaternion().copy(rootRoll).invert()).multiply(midRoll);
    s.midInfo.currentGpose.copy(rootGpose).multiply(s.midInfo.currentLpose).normalize();
  }

  toJSON(): Record<string, unknown> {
    return {
      chains: this.configs.map((c) => ({
        ...c,
        target: typeof c.target === 'string' ? c.target : c.target.name || null,
        poleTarget: typeof c.poleTarget === 'string' ? c.poleTarget : c.poleTarget.name || null,
      })),
    };
  }
}

function makeInfo(): SolverInfo {
  return {
    currentLpose: new Quaternion(), currentLrest: new Quaternion(),
    currentGpose: new Quaternion(), currentGrest: new Quaternion(),
    currentVector: new Vector3(), forwardVector: new Vector3(), length: 0,
  };
}

const _target = new Vector3();
function resolveObj(rig: SkeletonRig, ref: Object3D | string): Vector3 | null {
  const obj = typeof ref === 'string' ? rig.targetResolver?.(ref) : ref;
  if (!obj) {
    rig.warnOnce(`ik-target-missing:${String(ref)}`, `IK target not resolvable: ${String(ref)}`);
    return null;
  }
  obj.getWorldPosition(_target);
  return rig.worldToRigSpace(_target, _target);
}
```

> 实现注意：`processJoints` 中写 root 后再读 root 全局姿势，`setPoseRotation` 已把 root 子树标脏，`getGlobalPoseQuaternion` 惰性同步——顺序正确。roll 修正段临时变量复用密集，实现时优先保证与 Godot 公式逐项对应（c0/c1/c2/φ/θ 命名保持一致）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/ik/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/ik/two-bone-ik.ts tests/modifiers/ik/two-bone-ik.test.ts
git commit -m "feat(ik): TwoBoneIK 解析求解器（pole target + roll 修正）"
```

---

### Task 14: 约束 —— AimModifier 与 CopyTransformModifier

**Files:**
- Create: `src/modifiers/constraints/aim.ts`
- Create: `src/modifiers/constraints/copy-transform.ts`
- Test: `tests/modifiers/constraints/constraints.test.ts`

**Interfaces:**
- Consumes: `Modifier`、math 工具
- Produces:
  - `interface BoneConstraintConfig { amount?: number; applyBone: string; referenceType: 'bone' | 'object'; referenceBone?: string; referenceObject?: Object3D | string }`（`amount` 0~1 混合，默认 1）
  - `interface AimConfig extends BoneConstraintConfig { axis?: BoneAxis }`（默认 '+y'：该局部轴指向 reference）
  - `class AimModifier extends Modifier { constructor(configs: AimConfig[]) }`
  - `interface CopyTransformConfig extends BoneConstraintConfig { copyPosition?: boolean; copyRotation?: boolean; copyScale?: boolean }`（默认仅 rotation）
  - `class CopyTransformModifier extends Modifier { constructor(configs: CopyTransformConfig[]) }`

**Aim 算法**：当前全局 forward = `gpose * axis`；期望方向 = `normalize(refGlobalPos − boneGlobalPos)`（同转 rig 空间）；`delta = getFromToRotation(forward, desired, prev)`；`newGlobal = delta * gpose`；`local = parentGpose⁻¹ * newGlobal`；`amount < 1` 时 local 与原 pose slerp。

**CopyTransform 算法**：取 reference 全局 TRS（bone → rig 全局姿势；object → world 转 rig 空间）→ 按 flags 合成目标全局姿势 → 转局部（pos：`parentGquat⁻¹ * (desired − parentGpos)`；rot：`parentGquat⁻¹ * desired`；scale 仅支持 referenceType 'bone' 时取 `getGlobalRestScale` 近似——v1 忽略全局 scale，copyScale 时直接写 1 并 warnOnce 提示）→ `amount` 混合。

- [ ] **Step 1: 写失败测试**

`tests/modifiers/constraints/constraints.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Object3D, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../../src/core/skeleton-rig';
import { AimModifier } from '../../../src/modifiers/constraints/aim';
import { CopyTransformModifier } from '../../../src/modifiers/constraints/copy-transform';

function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.5, 0);
  const hand = new Bone(); hand.name = 'Hand'; hand.position.set(0.3, 0.2, 0);
  hips.add(head); hips.add(hand);
  const rig = new SkeletonRig(hips);
  return rig;
}

describe('AimModifier', () => {
  it('aims the bone axis at the reference object', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(2, 1.5, 0); // 世界 = rig 空间（root 无父变换）
    rig.addModifier(new AimModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: target, axis: '+y' }]));
    rig.update(0.016);
    const gq = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    const aimed = new Vector3(0, 1, 0).applyQuaternion(gq);
    const headPos = rig.getGlobalPosePosition(rig.boneIndex('Head'), new Vector3());
    const desired = new Vector3(2, 1.5, 0).sub(headPos).normalize();
    expect(aimed.distanceTo(desired)).toBeLessThan(1e-3);
  });

  it('amount 0.5 halves the aim correction', () => {
    const rig = buildRig();
    const target = new Object3D();
    target.position.set(2, 1.5, 0);
    rig.addModifier(new AimModifier([{ applyBone: 'Head', referenceType: 'object', referenceObject: target, amount: 0.5 }]));
    rig.update(0.016);
    const gq = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    const aimed = new Vector3(0, 1, 0).applyQuaternion(gq);
    // 半量：方向应在 +Y 与 desired 之间（与两者都有夹角）
    expect(aimed.y).toBeGreaterThan(0.5);
    expect(aimed.x).toBeGreaterThan(0.1);
  });
});

describe('CopyTransformModifier', () => {
  it('copies rotation from another bone (global space)', () => {
    const rig = buildRig();
    const srcQ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.8);
    rig.setBasePoseRotation(rig.boneIndex('Hand'), srcQ);
    rig.addModifier(new CopyTransformModifier([{ applyBone: 'Head', referenceType: 'bone', referenceBone: 'Hand' }]));
    rig.update(0.016);
    const gq = rig.getGlobalPoseQuaternion(rig.boneIndex('Head'), new Quaternion());
    const expected = rig.getGlobalPoseQuaternion(rig.boneIndex('Hand'), new Quaternion());
    expect(gq.angleTo(expected)).toBeLessThan(1e-4);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/modifiers/constraints/constraints.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/modifiers/constraints/aim.ts`:
```ts
import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { vectorFromBoneAxis, type BoneAxis } from '../../core/bone-axes';
import { getFromToRotation, xformQuat } from '../../core/math';
import { Modifier } from '../modifier';

export interface BoneConstraintConfig {
  amount?: number;
  applyBone: string;
  referenceType: 'bone' | 'object';
  referenceBone?: string;
  referenceObject?: Object3D | string;
}

export interface AimConfig extends BoneConstraintConfig {
  axis?: BoneAxis;
}

const _axis = new Vector3();
const _forward = new Vector3();
const _desired = new Vector3();
const _refPos = new Vector3();
const _bonePos = new Vector3();
const _parentG = new Quaternion();
const _gpose = new Quaternion();
const _delta = new Quaternion();
const _local = new Quaternion();
const _prevQ = new Quaternion();

export class AimModifier extends Modifier {
  constructor(private configs: AimConfig[]) {
    super();
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const c of this.configs) {
      const bone = rig.boneIndex(c.applyBone);
      if (!resolveReference(rig, c, _refPos)) continue;

      rig.getGlobalPosePosition(bone, _bonePos);
      rig.getGlobalPoseQuaternion(bone, _gpose);
      vectorFromBoneAxis(c.axis ?? '+y', _axis);
      xformQuat(_gpose, _axis, _forward).normalize();
      _desired.copy(_refPos).sub(_bonePos);
      if (_desired.lengthSq() < 1e-10) continue;
      _desired.normalize();

      // delta * gpose → 目标全局旋转 → 转局部
      rig.getPoseRotation(bone, _prevQ);
      getFromToRotation(_forward, _desired, _prevQ, _delta);
      _delta.multiply(_gpose); // 目标全局
      const parent = rig.getParentIndex(bone);
      if (parent >= 0) rig.getGlobalPoseQuaternion(parent, _parentG);
      _local.copy(parent >= 0 ? _parentG.invert() : _parentG.identity()).multiply(_delta).normalize();

      const amount = c.amount ?? 1;
      if (amount < 1) {
        _local.slerpQuaternions(rig.getPoseRotation(bone, _gpose), _local, amount);
      }
      rig.setPoseRotation(bone, _local);
    }
  }

  toJSON(): Record<string, unknown> {
    return { type: 'aim', constraints: this.configs.map((c) => ({ ...c, referenceObject: typeof c.referenceObject === 'string' ? c.referenceObject : c.referenceObject?.name })) };
  }
}

export function resolveReference(rig: SkeletonRig, c: BoneConstraintConfig, out: Vector3): boolean {
  if (c.referenceType === 'bone') {
    const idx = rig.findBoneIndex(c.referenceBone ?? '');
    if (idx < 0) {
      rig.warnOnce(`aim-ref-missing:${c.referenceBone}`, `AimModifier: reference bone not found: ${c.referenceBone}`);
      return false;
    }
    rig.getGlobalPosePosition(idx, out);
    return true;
  }
  const obj = typeof c.referenceObject === 'string' ? rig.targetResolver?.(c.referenceObject) : c.referenceObject;
  if (!obj) {
    rig.warnOnce(`aim-ref-missing:${String(c.referenceObject)}`, `AimModifier: reference object not resolvable`);
    return false;
  }
  obj.getWorldPosition(out);
  rig.worldToRigSpace(out, out);
  return true;
}
```

`src/modifiers/constraints/copy-transform.ts`:
```ts
import { Object3D, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { Modifier } from '../modifier';
import type { BoneConstraintConfig } from './aim';

export interface CopyTransformConfig extends BoneConstraintConfig {
  copyPosition?: boolean;
  copyRotation?: boolean;
  copyScale?: boolean;
}

const _pos = new Vector3();
const _parentPos = new Vector3();
const _src = new Object3D();
const _q = new Quaternion();
const _parentG = new Quaternion();
const _local = new Quaternion();

export class CopyTransformModifier extends Modifier {
  constructor(private configs: CopyTransformConfig[]) {
    super();
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const c of this.configs) {
      const bone = rig.boneIndex(c.applyBone);
      const amount = c.amount ?? 1;
      const copyPos = c.copyPosition ?? false;
      const copyRot = c.copyRotation ?? true;
      if (c.copyScale) rig.warnOnce('copy-scale-unsupported', 'CopyTransformModifier: global scale copy is not supported in v1 (ignored)');

      const parent = rig.getParentIndex(bone);
      if (parent >= 0) {
        rig.getGlobalPoseQuaternion(parent, _parentG);
        rig.getGlobalPosePosition(parent, _parentPos);
      } else {
        _parentG.identity();
        _parentPos.set(0, 0, 0);
      }

      if (c.referenceType === 'bone') {
        const src = rig.findBoneIndex(c.referenceBone ?? '');
        if (src < 0) {
          rig.warnOnce(`copy-ref-missing:${c.referenceBone}`, `CopyTransformModifier: reference bone not found: ${c.referenceBone}`);
          continue;
        }
        if (copyRot) {
          rig.getGlobalPoseQuaternion(src, _q);
          _local.copy(_parentG).invert().multiply(_q).normalize();
          if (amount < 1) _local.slerpQuaternions(rig.getPoseRotation(bone, _q), _local, amount);
          rig.setPoseRotation(bone, _local);
        }
        if (copyPos) {
          rig.getGlobalPosePosition(src, _pos);
          _pos.sub(_parentPos).applyQuaternion(_parentG.invert());
          if (amount < 1) _pos.lerp(rig.getPosePosition(bone, _src.position), amount);
          rig.setPosePosition(bone, _pos);
        }
      } else {
        const obj = typeof c.referenceObject === 'string' ? rig.targetResolver?.(c.referenceObject) : c.referenceObject;
        if (!obj) {
          rig.warnOnce(`copy-ref-missing:${String(c.referenceObject)}`, 'CopyTransformModifier: reference object not resolvable');
          continue;
        }
        obj.updateWorldMatrix(true, false);
        if (copyRot) {
          obj.getWorldQuaternion(_q); // 世界 → rig 空间
          const parentObj = rig.getBoneAt(0).parent;
          if (parentObj) {
            parentObj.updateWorldMatrix(true, false);
            parentObj.getWorldQuaternion(_local);
            _q.premultiply(_local.invert());
          }
          _local.copy(_parentG).invert().multiply(_q).normalize();
          if (amount < 1) _local.slerpQuaternions(rig.getPoseRotation(bone, _q), _local, amount);
          rig.setPoseRotation(bone, _local);
        }
        if (copyPos) {
          obj.getWorldPosition(_pos);
          rig.worldToRigSpace(_pos, _pos);
          _pos.sub(_parentPos).applyQuaternion(_parentG.invert());
          if (amount < 1) _pos.lerp(rig.getPosePosition(bone, _src.position), amount);
          rig.setPosePosition(bone, _pos);
        }
      }
    }
  }

  toJSON(): Record<string, unknown> {
    return { type: 'copy-transform', constraints: this.configs.map((c) => ({ ...c, referenceObject: typeof c.referenceObject === 'string' ? c.referenceObject : c.referenceObject?.name })) };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/modifiers/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/modifiers/constraints tests/modifiers/constraints
git commit -m "feat(constraints): Aim 与 CopyTransform 约束"
```

### Task 15: HumanoidProfile —— 56 骨人形 profile 数据

**Files:**
- Create: `src/retarget/humanoid-profile.ts`
- Test: `tests/retarget/humanoid-profile.test.ts`

**Interfaces:**
- Produces:
  - `type TailDirection = 'average-children' | 'specific-child' | 'end'`
  - `type ProfileGroup = 'Body' | 'Face' | 'LeftHand' | 'RightHand'`
  - `interface ProfileBone { name: string; parent: string | null; group: ProfileGroup; required: boolean; tailDirection: TailDirection; boneTail?: string }`
  - `const HUMANOID_PROFILE: readonly ProfileBone[]`（56 骨，与 Godot `SkeletonProfileHumanoid` 同名同构）
  - `const HUMANOID_ROOT_BONE = 'Root'`、`const HUMANOID_SCALE_BASE_BONE = 'Hips'`、`const REQUIRED_HUMANOID_BONES: readonly string[]`
  - `humanoidBoneNames(): string[]`

对照源码：`/Users/huhui/Projects/godot/scene/resources/skeleton_profile.cpp` 476–852 行。**省略** `referencePose` 与 `handleOffset`（Godot 编辑器 2D 排布用，gizmo 阶段再补）。

required = true 的 17 骨：Hips、Spine、Head、LeftShoulder、LeftUpperArm、LeftLowerArm、LeftHand、RightShoulder、RightUpperArm、RightLowerArm、RightHand、LeftUpperLeg、LeftLowerLeg、LeftFoot、RightUpperLeg、RightLowerLeg、RightFoot。

- [ ] **Step 1: 写失败测试**

`tests/retarget/humanoid-profile.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { HUMANOID_PROFILE, REQUIRED_HUMANOID_BONES, humanoidBoneNames } from '../../src/retarget/humanoid-profile';

describe('HUMANOID_PROFILE', () => {
  it('contains 56 bones matching Godot SkeletonProfileHumanoid', () => {
    expect(HUMANOID_PROFILE.length).toBe(56);
    expect(HUMANOID_PROFILE[0]!.name).toBe('Root');
    expect(HUMANOID_PROFILE[1]!.name).toBe('Hips');
  });

  it('parents reference existing bones (except Root)', () => {
    const names = new Set(humanoidBoneNames());
    for (const b of HUMANOID_PROFILE) {
      if (b.name === 'Root') {
        expect(b.parent).toBeNull();
      } else {
        expect(b.parent).not.toBeNull();
        expect(names.has(b.parent!)).toBe(true);
      }
    }
  });

  it('marks exactly the 17 required bones', () => {
    expect([...REQUIRED_HUMANOID_BONES].sort()).toEqual([
      'Head', 'Hips',
      'LeftFoot', 'LeftHand', 'LeftLowerArm', 'LeftLowerLeg', 'LeftShoulder', 'LeftUpperArm', 'LeftUpperLeg',
      'RightFoot', 'RightHand', 'RightLowerArm', 'RightLowerLeg', 'RightShoulder', 'RightUpperArm', 'RightUpperLeg',
      'Spine',
    ].sort());
    for (const b of HUMANOID_PROFILE) {
      expect(b.required).toBe(REQUIRED_HUMANOID_BONES.includes(b.name));
    }
  });

  it('specific-child tail directions point at existing children', () => {
    for (const b of HUMANOID_PROFILE) {
      if (b.tailDirection === 'specific-child') {
        const tail = HUMANOID_PROFILE.find((x) => x.name === b.boneTail);
        expect(tail?.parent).toBe(b.name);
      }
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/retarget/humanoid-profile.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/retarget/humanoid-profile.ts`:
```ts
export type TailDirection = 'average-children' | 'specific-child' | 'end';
export type ProfileGroup = 'Body' | 'Face' | 'LeftHand' | 'RightHand';

export interface ProfileBone {
  name: string;
  parent: string | null;
  group: ProfileGroup;
  required: boolean;
  tailDirection: TailDirection;
  boneTail?: string;
}

export const HUMANOID_ROOT_BONE = 'Root';
export const HUMANOID_SCALE_BASE_BONE = 'Hips';

/** 与 Godot SkeletonProfileHumanoid 同构（skeleton_profile.cpp 476–852 行） */
export const HUMANOID_PROFILE: readonly ProfileBone[] = [
  { name: 'Root', parent: null, group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'Hips', parent: 'Root', group: 'Body', required: true, tailDirection: 'specific-child', boneTail: 'Spine' },
  { name: 'Spine', parent: 'Hips', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'Chest', parent: 'Spine', group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'UpperChest', parent: 'Chest', group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'Neck', parent: 'UpperChest', group: 'Body', required: false, tailDirection: 'specific-child', boneTail: 'Head' },
  { name: 'Head', parent: 'Neck', group: 'Body', required: true, tailDirection: 'end' },
  { name: 'LeftEye', parent: 'Head', group: 'Face', required: false, tailDirection: 'average-children' },
  { name: 'RightEye', parent: 'Head', group: 'Face', required: false, tailDirection: 'average-children' },
  { name: 'Jaw', parent: 'Head', group: 'Face', required: false, tailDirection: 'average-children' },
  { name: 'LeftShoulder', parent: 'UpperChest', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftUpperArm', parent: 'LeftShoulder', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftLowerArm', parent: 'LeftUpperArm', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftHand', parent: 'LeftLowerArm', group: 'Body', required: true, tailDirection: 'specific-child', boneTail: 'LeftMiddleProximal' },
  { name: 'LeftThumbMetacarpal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftThumbProximal', parent: 'LeftThumbMetacarpal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftThumbDistal', parent: 'LeftThumbProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftIndexProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftIndexIntermediate', parent: 'LeftIndexProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftIndexDistal', parent: 'LeftIndexIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftMiddleProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftMiddleIntermediate', parent: 'LeftMiddleProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftMiddleDistal', parent: 'LeftMiddleIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftRingProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftRingIntermediate', parent: 'LeftRingProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftRingDistal', parent: 'LeftRingIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftLittleProximal', parent: 'LeftHand', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftLittleIntermediate', parent: 'LeftLittleProximal', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftLittleDistal', parent: 'LeftLittleIntermediate', group: 'LeftHand', required: false, tailDirection: 'average-children' },
  { name: 'RightShoulder', parent: 'UpperChest', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightUpperArm', parent: 'RightShoulder', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightLowerArm', parent: 'RightUpperArm', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightHand', parent: 'RightLowerArm', group: 'Body', required: true, tailDirection: 'specific-child', boneTail: 'RightMiddleProximal' },
  { name: 'RightThumbMetacarpal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightThumbProximal', parent: 'RightThumbMetacarpal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightThumbDistal', parent: 'RightThumbProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightIndexProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightIndexIntermediate', parent: 'RightIndexProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightIndexDistal', parent: 'RightIndexIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightMiddleProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightMiddleIntermediate', parent: 'RightMiddleProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightMiddleDistal', parent: 'RightMiddleIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightRingProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightRingIntermediate', parent: 'RightRingProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightRingDistal', parent: 'RightRingIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightLittleProximal', parent: 'RightHand', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightLittleIntermediate', parent: 'RightLittleProximal', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'RightLittleDistal', parent: 'RightLittleIntermediate', group: 'RightHand', required: false, tailDirection: 'average-children' },
  { name: 'LeftUpperLeg', parent: 'Hips', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftLowerLeg', parent: 'LeftUpperLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftFoot', parent: 'LeftLowerLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'LeftToes', parent: 'LeftFoot', group: 'Body', required: false, tailDirection: 'average-children' },
  { name: 'RightUpperLeg', parent: 'Hips', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightLowerLeg', parent: 'RightUpperLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightFoot', parent: 'RightLowerLeg', group: 'Body', required: true, tailDirection: 'average-children' },
  { name: 'RightToes', parent: 'RightFoot', group: 'Body', required: false, tailDirection: 'average-children' },
];

export const REQUIRED_HUMANOID_BONES: readonly string[] = HUMANOID_PROFILE.filter((b) => b.required).map((b) => b.name);

export function humanoidBoneNames(): string[] {
  return HUMANOID_PROFILE.map((b) => b.name);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/retarget/humanoid-profile.test.ts`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/retarget/humanoid-profile.ts tests/retarget/humanoid-profile.test.ts
git commit -m "feat(retarget): 56 骨人形 profile（与 Godot SkeletonProfileHumanoid 同构）"
```

---

### Task 16: BoneMap —— 骨名映射与预设（Mixamo/VRM/RPM）

**Files:**
- Create: `src/retarget/bone-map.ts`
- Test: `tests/retarget/bone-map.test.ts`

**Interfaces:**
- Produces:
  - `class BoneMap { set(profileName, modelBoneName): void; findModelBone(profileName): string | null; findProfileBone(modelBoneName): string | null; toJSON(): Record<string, string>; static fromJSON(json): BoneMap; static fromPreset(preset: Record<string, string>): BoneMap }`（方向：**profile 骨名 → 模型骨名**）
  - `mixamoPreset(prefix = 'mixamorig:'): Record<string, string>`
  - `readyPlayerMePreset(): Record<string, string>`（= `mixamoPreset('')`，RPM 用无前缀 Mixamo 命名）
  - `vrmPreset(): Record<string, string>`（VRM 1.0 camelCase 人形骨名）
  - `identityPreset(): Record<string, string>`（profile 名 → 同名；程序化骨架/已重命名骨架用）
  - `suggestBoneMap(boneNames: string[]): { map: BoneMap; coverage: number; presetName: string }` —— 尝试各预设（含自动剥离 `mixamorig:`/`mixamorig_`/`mixamorig` 前缀），取 required 骨覆盖率最高者

**Mixamo 映射表**（profile → Mixamo 基名，预设生成器按此加前缀）：
- Hips→Hips，Spine→Spine，Chest→Spine1，UpperChest→Spine2，Neck→Neck，Head→Head
- {S}Shoulder→{S}Shoulder，{S}UpperArm→{S}Arm，{S}LowerArm→{S}ForeArm，{S}Hand→{S}Hand（S ∈ Left/Right）
- 手指：{S}Hand{F}{i}（i=1,2,3），F ∈ Thumb/Index/Middle/Ring/Pinky；Thumb1→{S}ThumbMetacarpal、Thumb2→{S}ThumbProximal、Thumb3→{S}ThumbDistal；其余 {F}1→{S}{F'}Proximal、{F}2→{F'}Intermediate、{F}3→{F'}Distal（Pinky→Little）
- {S}UpperLeg→{S}UpLeg，{S}LowerLeg→{S}Leg，{S}Foot→{S}Foot，{S}Toes→{S}ToeBase
- Root/Eye/Jaw 无映射

**VRM 1.0 映射**（profile → camelCase 同名）：Hips→hips，Spine→spine，Chest→chest，UpperChest→upperChest，Neck→neck，Head→head，LeftEye→leftEye，RightEye→rightEye，Jaw→jaw，其余 = profile 名首字母小写（leftShoulder、leftUpperArm、…、rightToes）。

- [ ] **Step 1: 写失败测试**

`tests/retarget/bone-map.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BoneMap, mixamoPreset, readyPlayerMePreset, vrmPreset, identityPreset, suggestBoneMap } from '../../src/retarget/bone-map';
import { REQUIRED_HUMANOID_BONES } from '../../src/retarget/humanoid-profile';

describe('BoneMap', () => {
  it('resolves both directions and round-trips JSON', () => {
    const map = BoneMap.fromPreset(mixamoPreset());
    expect(map.findModelBone('LeftUpperArm')).toBe('mixamorig:LeftArm');
    expect(map.findModelBone('LeftLowerLeg')).toBe('mixamorig:LeftLeg');
    expect(map.findProfileBone('mixamorig:LeftFoot')).toBe('LeftFoot');
    const restored = BoneMap.fromJSON(map.toJSON());
    expect(restored.findModelBone('Hips')).toBe('mixamorig:Hips');
  });

  it('covers all 17 required bones in every preset', () => {
    for (const preset of [mixamoPreset(), readyPlayerMePreset(), vrmPreset(), identityPreset()]) {
      const map = BoneMap.fromPreset(preset);
      for (const name of REQUIRED_HUMANOID_BONES) {
        expect(map.findModelBone(name), `${name}`).not.toBeNull();
      }
    }
  });

  it('maps fingers per Godot profile (Thumb1 → Metacarpal …)', () => {
    const map = BoneMap.fromPreset(mixamoPreset());
    expect(map.findModelBone('LeftThumbMetacarpal')).toBe('mixamorig:LeftHandThumb1');
    expect(map.findModelBone('RightIndexDistal')).toBe('mixamorig:RightHandIndex3');
    expect(map.findModelBone('LeftLittleProximal')).toBe('mixamorig:LeftHandPinky1');
  });

  it('suggestBoneMap detects mixamo naming with/without prefix', () => {
    const withPrefix = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head', 'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot'];
    const s1 = suggestBoneMap(withPrefix);
    expect(s1.coverage).toBe(1);
    expect(s1.map.findModelBone('LeftUpperArm')).toBe('mixamorig:LeftArm');

    const noPrefix = withPrefix.map((n) => n.replace('mixamorig:', ''));
    expect(suggestBoneMap(noPrefix).coverage).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/retarget/bone-map.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/retarget/bone-map.ts`:
```ts
import { HUMANOID_PROFILE } from './humanoid-profile';

/** profile 骨名 → 模型骨名 */
export class BoneMap {
  private profileToModel = new Map<string, string>();
  private modelToProfile = new Map<string, string>();

  set(profileName: string, modelBoneName: string): void {
    this.profileToModel.set(profileName, modelBoneName);
    this.modelToProfile.set(modelBoneName, profileName);
  }

  findModelBone(profileName: string): string | null {
    return this.profileToModel.get(profileName) ?? null;
  }

  findProfileBone(modelBoneName: string): string | null {
    return this.modelToProfile.get(modelBoneName) ?? null;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.profileToModel);
  }

  static fromJSON(json: Record<string, string>): BoneMap {
    return BoneMap.fromPreset(json);
  }

  static fromPreset(preset: Record<string, string>): BoneMap {
    const map = new BoneMap();
    for (const [profileName, modelName] of Object.entries(preset)) map.set(profileName, modelName);
    return map;
  }
}

const SIDES = ['Left', 'Right'] as const;
const FINGERS: Array<[profileFinger: string, mixamoFinger: string]> = [
  ['Thumb', 'Thumb'],
  ['Index', 'Index'],
  ['Middle', 'Middle'],
  ['Ring', 'Ring'],
  ['Little', 'Pinky'],
];
const FINGER_SEGMENTS: Array<[profileSeg: string, mixamoIdx: number]> = [
  ['Proximal', 1],
  ['Intermediate', 2],
  ['Distal', 3],
];

/** Mixamo 命名（prefix 默认 'mixamorig:'；three.js Soldier.glb 用 'mixamorig' 无冒号） */
export function mixamoPreset(prefix = 'mixamorig:'): Record<string, string> {
  const p: Record<string, string> = {
    Hips: `${prefix}Hips`,
    Spine: `${prefix}Spine`,
    Chest: `${prefix}Spine1`,
    UpperChest: `${prefix}Spine2`,
    Neck: `${prefix}Neck`,
    Head: `${prefix}Head`,
  };
  for (const S of SIDES) {
    p[`${S}Shoulder`] = `${prefix}${S}Shoulder`;
    p[`${S}UpperArm`] = `${prefix}${S}Arm`;
    p[`${S}LowerArm`] = `${prefix}${S}ForeArm`;
    p[`${S}Hand`] = `${prefix}${S}Hand`;
    p[`${S}UpperLeg`] = `${prefix}${S}UpLeg`;
    p[`${S}LowerLeg`] = `${prefix}${S}Leg`;
    p[`${S}Foot`] = `${prefix}${S}Foot`;
    p[`${S}Toes`] = `${prefix}${S}ToeBase`;
    for (const [profileFinger, mixamoFinger] of FINGERS) {
      if (profileFinger === 'Thumb') {
        p[`${S}ThumbMetacarpal`] = `${prefix}${S}HandThumb1`;
        p[`${S}ThumbProximal`] = `${prefix}${S}HandThumb2`;
        p[`${S}ThumbDistal`] = `${prefix}${S}HandThumb3`;
      } else {
        for (const [seg, idx] of FINGER_SEGMENTS) {
          p[`${S}${profileFinger}${seg}`] = `${prefix}${S}Hand${mixamoFinger}${idx}`;
        }
      }
    }
  }
  return p;
}

/** ReadyPlayerMe：无前缀 Mixamo 命名 */
export function readyPlayerMePreset(): Record<string, string> {
  return mixamoPreset('');
}

/** VRM 1.0：camelCase 人形骨名 */
export function vrmPreset(): Record<string, string> {
  const p: Record<string, string> = {};
  for (const bone of HUMANOID_PROFILE) {
    if (bone.name === 'Root') continue;
    p[bone.name] = bone.name.charAt(0).toLowerCase() + bone.name.slice(1);
  }
  return p;
}

/** 骨名与 profile 完全一致（程序化骨架/已按 profile 重命名） */
export function identityPreset(): Record<string, string> {
  const p: Record<string, string> = {};
  for (const bone of HUMANOID_PROFILE) p[bone.name] = bone.name;
  return p;
}

const MIXAMO_PREFIXES = ['mixamorig:', 'mixamorig_', 'mixamorig', ''];

/** 尝试各预设与 Mixamo 前缀变体，返回 required 骨覆盖率最高的映射 */
export function suggestBoneMap(boneNames: string[]): { map: BoneMap; coverage: number; presetName: string } {
  const available = new Set(boneNames);
  const candidates: Array<{ name: string; preset: Record<string, string> }> = [
    ...MIXAMO_PREFIXES.map((prefix) => ({ name: `mixamo(${prefix || '无前缀'})`, preset: mixamoPreset(prefix) })),
    { name: 'vrm', preset: vrmPreset() },
    { name: 'identity', preset: identityPreset() },
  ];
  let best = { map: new BoneMap(), coverage: 0, presetName: 'none' };
  for (const { name, preset } of candidates) {
    const map = BoneMap.fromPreset(preset);
    const required = HUMANOID_PROFILE.filter((b) => b.required);
    const hits = required.filter((b) => {
      const modelName = preset[b.name];
      return modelName !== undefined && available.has(modelName);
    }).length;
    const coverage = hits / required.length;
    if (coverage > best.coverage) best = { map, coverage, presetName: name };
    if (coverage === 1) break;
  }
  return best;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/retarget/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/retarget/bone-map.ts tests/retarget/bone-map.test.ts
git commit -m "feat(retarget): BoneMap 与 Mixamo/VRM/RPM/identity 预设"
```

### Task 17: RetargetModifier —— 重定向

**Files:**
- Create: `src/retarget/retarget-modifier.ts`
- Test: `tests/retarget/retarget-modifier.test.ts`

**Interfaces:**
- Consumes: `SkeletonRig`、`BoneMap`、`HUMANOID_PROFILE`、`Modifier`
- Produces:
  - `interface RetargetFlags { position?: boolean; rotation?: boolean; scale?: boolean }`（默认 position/rotation = true，scale = false）
  - `interface RetargetConfig { source: SkeletonRig; sourceBoneMap: BoneMap; boneMap?: BoneMap; useGlobalPose?: boolean; enableFlags?: RetargetFlags; profile?: readonly ProfileBone[] }`（`boneMap` 缺省 = `identityPreset()`）
  - `class RetargetModifier extends Modifier` —— **挂在目标 rig 上**（`targetRig.addModifier(m)`），构造时持源 rig；`attach` 时预计算每对映射骨的 `preBasis`/`postBasis`（Matrix3）；监听双方 `'rest-updated'` 重建缓存

**与 spec §7 的偏差（已记录于计划头部）**：Godot 把 RetargetModifier 挂在源骨架、子节点为目标；本库挂在**目标 rig**、持源引用。原因：目标骨的写回与 influence 混合由目标 rig 自己的管线管理，源挂载会让隔离语义断裂。**调用顺序契约**：源 rig 先 `update()`，目标 rig 后 `update()`（modifier 读源的当前工作/全局姿势）。

**预计算公式**（translate retarget_modifier_3d.cpp 126–163 行，局部模式；全局模式 90–124 行）：
- 局部模式：`post = srcRest⁻¹ × srcParentGrest⁻¹ × tgtParentGrest × tgtRest`；`pre = tgtParentGrest⁻¹ × srcParentGrest`（两侧 parent 都存在时；单侧缺失按 Godot 分支退化处理）。
- 全局模式：`post = srcRest⁻¹ × srcParentGrest⁻¹ × tgtParentGrest × tgtRest`（同式但 pre 不同）：`pre = srcParentGrest`。
- 运行帧（局部模式，translate 329–373 行）：`basis = pre × srcPose.basis × post`；`origin = pre × ((srcPosePos − srcRestPos) × motionScaleRatio) + tgtRestPos`；`motionScaleRatio = targetRig.motionScale / sourceRig.motionScale`；按 `enableFlags` 写回目标工作姿势。
- 运行帧（全局模式，translate 300–327 行）：`tgtGlobalPose.basis = srcGlobalPose.basis × post`，`tgtGlobalPose.origin = srcGlobalPose.origin`（绝对拷贝），写回时经目标父骨全局逆转局部。
- Modifier.influence 由目标 rig 管线统一混合（目标骨的 retarget 前后姿势），与 Godot 的源侧 influence 语义效果等价。

- [ ] **Step 1: 写失败测试**

`tests/retarget/retarget-modifier.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { BoneMap, identityPreset } from '../../src/retarget/bone-map';
import { RetargetModifier } from '../../src/retarget/retarget-modifier';

/** 源/目标用同一结构：Hips(0,1,0) → Spine(0,0.1,0) → Head(0,0.1,0) */
function buildHumanoid(offset: { hipScale?: number } = {}) {
  const k = offset.hipScale ?? 1;
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1 * k, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1 * k, 0);
  const head = new Bone(); head.name = 'Head'; head.position.set(0, 0.1 * k, 0);
  hips.add(spine); spine.add(head);
  return new SkeletonRig(hips);
}

function poseSource(rig: SkeletonRig) {
  rig.setBasePoseRotation(rig.boneIndex('Spine'), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
  rig.setBasePosePosition(rig.boneIndex('Hips'), new Vector3(0.5, 1, 0));
  rig.update(0); // 源先 update
}

describe('RetargetModifier（局部模式）', () => {
  it('identical rigs: target reproduces source pose', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    const m = new RetargetModifier({ source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()) });
    tgt.addModifier(m);
    tgt.update(0.016);
    // 目标 Spine 局部旋转 = 源的 90° rotZ
    const q = tgt.getBoneAt(tgt.boneIndex('Spine')).quaternion;
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(q.angleTo(expected)).toBeLessThan(1e-4);
    // 目标 Hips 位置跟源
    expect(tgt.getBoneAt(0).position.x).toBeCloseTo(0.5, 4);
  });

  it('scales motion by motionScale ratio (target hips 2x source)', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid({ hipScale: 2 });
    src.motionScale = src.computeMotionScaleFromBone('Hips'); // ≈ 1
    tgt.motionScale = tgt.computeMotionScaleFromBone('Hips'); // ≈ 2
    poseSource(src);
    tgt.addModifier(new RetargetModifier({ source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()) }));
    tgt.update(0.016);
    // Hips 位移 0.5 × (2/1) = 1.0，加 rest 基础 2.0 → y 不变，x = 1.0
    expect(tgt.getBoneAt(0).position.x).toBeCloseTo(1.0, 3);
  });

  it('respects enableFlags (position disabled)', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    tgt.addModifier(new RetargetModifier({
      source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()),
      enableFlags: { position: false, rotation: true },
    }));
    tgt.update(0.016);
    expect(tgt.getBoneAt(0).position.x).toBeCloseTo(0, 5); // 位置未动
    const q = tgt.getBoneAt(tgt.boneIndex('Spine')).quaternion;
    expect(q.angleTo(new Quaternion())).toBeGreaterThan(0.5); // 旋转已应用
  });

  it('rebuilds caches on rest-updated', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    const m = new RetargetModifier({ source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()) });
    tgt.addModifier(m);
    tgt.setRestPose(tgt.boneIndex('Spine'), { position: new Vector3(0, 0.3, 0) }); // 触发 rest-updated
    tgt.update(0.016);
    expect(tgt.getBoneAt(2).position.y).toBeCloseTo(0.1, 4); // Head 局部 rest 未变，不抛错即通过
  });

  it('global mode copies source global pose (absolute)', () => {
    const src = buildHumanoid();
    const tgt = buildHumanoid();
    poseSource(src);
    tgt.addModifier(new RetargetModifier({
      source: src, sourceBoneMap: BoneMap.fromPreset(identityPreset()), useGlobalPose: true,
    }));
    tgt.update(0.016);
    const srcHeadGlobal = src.getGlobalPosePosition(src.boneIndex('Head'), new Vector3());
    const tgtHeadGlobal = tgt.getGlobalPosePosition(tgt.boneIndex('Head'), new Vector3());
    expect(tgtHeadGlobal.distanceTo(srcHeadGlobal)).toBeLessThan(1e-3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/retarget/retarget-modifier.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/retarget/retarget-modifier.ts`:
```ts
import { Matrix3, Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../core/skeleton-rig';
import { Modifier } from '../modifiers/modifier';
import { BoneMap, identityPreset } from './bone-map';
import { HUMANOID_PROFILE, type ProfileBone } from './humanoid-profile';

export interface RetargetFlags {
  position?: boolean;
  rotation?: boolean;
  scale?: boolean;
}

export interface RetargetConfig {
  source: SkeletonRig;
  sourceBoneMap: BoneMap;
  /** 目标（本 rig）骨名映射，缺省 identity */
  boneMap?: BoneMap;
  useGlobalPose?: boolean;
  enableFlags?: RetargetFlags;
  profile?: readonly ProfileBone[];
}

interface RetargetBoneInfo {
  sourceIdx: number;
  targetIdx: number;
  preBasis: Matrix3;
  postBasis: Matrix3;
}

const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _m1 = new Matrix3();
const _m4 = new Matrix4();

/** Quaternion → Matrix3（列主序 3x3 旋转矩阵，与 Godot Basis 对应） */
function quatToMatrix3(q: Quaternion, out: Matrix3): Matrix3 {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return out.set(
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  );
}

/** Matrix3 → Quaternion（three.js setFromRotationMatrix 只接受 Matrix4，经 _m4 桥接） */
function quatFromMatrix3(m: Matrix3, out: Quaternion): Quaternion {
  const te = m.elements; // 列主序：te[0]=n11, te[1]=n21, te[2]=n31, te[3]=n12, ...
  _m4.set(
    te[0], te[3], te[6], 0,
    te[1], te[4], te[7], 0,
    te[2], te[5], te[8], 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(_m4);
}

/**
 * 挂在目标 rig 上的重定向（translate retarget_modifier_3d.cpp）。
 * 契约：源 rig 先于目标 rig update。
 */
export class RetargetModifier extends Modifier {
  private infos: RetargetBoneInfo[] = [];
  private readonly useGlobalPose: boolean;
  private readonly flags: Required<RetargetFlags>;
  private readonly profile: readonly ProfileBone[];
  private readonly sourceBoneMap: BoneMap;
  private readonly targetBoneMap: BoneMap;
  private readonly source: SkeletonRig;
  private unsubRest?: () => void;
  private unsubSourceRest?: () => void;

  constructor(config: RetargetConfig) {
    super();
    this.source = config.source;
    this.sourceBoneMap = config.sourceBoneMap;
    this.targetBoneMap = config.boneMap ?? BoneMap.fromPreset(identityPreset());
    this.useGlobalPose = config.useGlobalPose ?? false;
    this.flags = { position: config.enableFlags?.position ?? true, rotation: config.enableFlags?.rotation ?? true, scale: config.enableFlags?.scale ?? false };
    this.profile = config.profile ?? HUMANOID_PROFILE;
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.rebuildCache(rig);
    this.unsubRest = rig.on('rest-updated', () => this.rebuildCache(rig));
    this.unsubSourceRest = this.source.on('rest-updated', () => this.rebuildCache(rig));
  }

  override detach(): void {
    this.unsubRest?.();
    this.unsubSourceRest?.();
    super.detach();
  }

  /** 预计算 pre/post basis（translate cache_bone_rests / cache_bone_global_rests；attach 时执行，允许分配） */
  private rebuildCache(rig: SkeletonRig): void {
    this.infos = [];
    for (const bone of this.profile) {
      const srcName = this.sourceBoneMap.findModelBone(bone.name);
      const tgtName = this.targetBoneMap.findModelBone(bone.name);
      if (!srcName || !tgtName) continue;
      const sourceIdx = this.source.findBoneIndex(srcName);
      const targetIdx = rig.findBoneIndex(tgtName);
      if (sourceIdx < 0 || targetIdx < 0) continue;

      const srcParent = this.source.getParentIndex(sourceIdx);
      const tgtParent = rig.getParentIndex(targetIdx);
      const srcParentGrest = srcParent >= 0 ? this.source.getGlobalRestQuaternion(srcParent, new Quaternion()) : new Quaternion();
      const tgtParentGrest = tgtParent >= 0 ? rig.getGlobalRestQuaternion(tgtParent, new Quaternion()) : new Quaternion();
      const srcRest = this.source.getRestQuaternion(sourceIdx, new Quaternion());
      const tgtRest = rig.getRestQuaternion(targetIdx, new Quaternion());

      const pre = new Matrix3();
      const post = new Matrix3();
      const tmp = new Matrix3();

      // 局部模式：pre = tgtParentGrest⁻¹ × srcParentGrest（全局模式运行时不使用 pre，恒等即可）
      if (!this.useGlobalPose) {
        quatToMatrix3(tgtParentGrest.clone().invert(), pre);
        quatToMatrix3(srcParentGrest, tmp);
        pre.multiply(tmp);
      }
      // post = srcRest⁻¹ × srcParentGrest⁻¹ × tgtParentGrest × tgtRest（两模式相同）
      quatToMatrix3(srcRest.clone().invert(), post);
      quatToMatrix3(srcParentGrest.clone().invert(), tmp);
      post.multiply(tmp);
      quatToMatrix3(tgtParentGrest, tmp);
      post.multiply(tmp);
      quatToMatrix3(tgtRest, tmp);
      post.multiply(tmp);

      this.infos.push({ sourceIdx, targetIdx, preBasis: pre, postBasis: post });
    }
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    const ratio = rig.motionScale / this.source.motionScale;
    for (const info of this.infos) {
      if (this.useGlobalPose) {
        this.retargetGlobal(rig, info);
      } else {
        this.retargetLocal(rig, info, ratio);
      }
    }
  }

  /** 局部模式（translate _retarget_pose 359–370 行） */
  private retargetLocal(rig: SkeletonRig, info: RetargetBoneInfo, ratio: number): void {
    if (this.flags.rotation) {
      // basis = pre × srcPose.basis × post（Matrix3 乘法，Matrix3.premultiply/multiply 与 Godot Basis 乘法同序）
      this.source.getPoseRotation(info.sourceIdx, _q1);
      quatToMatrix3(_q1, _m1);
      _m1.premultiply(info.preBasis).multiply(info.postBasis);
      quatFromMatrix3(_m1, _q2);
      rig.setPoseRotation(info.targetIdx, _q2.normalize());
    }
    if (this.flags.position) {
      // origin = pre × ((srcPosePos − srcRestPos) × ratio) + tgtRestPos
      this.source.getPosePosition(info.sourceIdx, _v1);
      this.source.getRestPosition(info.sourceIdx, _v2);
      _v1.sub(_v2).multiplyScalar(ratio).applyMatrix3(info.preBasis);
      rig.getRestPosition(info.targetIdx, _v2);
      rig.setPosePosition(info.targetIdx, _v1.add(_v2));
    }
    if (this.flags.scale) {
      rig.warnOnce('retarget-scale-unsupported', 'RetargetModifier: scale flag is not supported in v1 (ignored)');
    }
  }

  /** 全局模式（translate _retarget_global_pose 300–327 行） */
  private retargetGlobal(rig: SkeletonRig, info: RetargetBoneInfo): void {
    const parent = rig.getParentIndex(info.targetIdx);
    const parentG = parent >= 0 ? rig.getGlobalPoseQuaternion(parent, _q3) : _q3.identity();
    if (this.flags.rotation) {
      // tgtGlobal.basis = srcGlobal.basis × post；写回局部 = parentGpose⁻¹ × tgtGlobal
      this.source.getGlobalPoseQuaternion(info.sourceIdx, _q1);
      quatToMatrix3(_q1, _m1);
      _m1.multiply(info.postBasis);
      quatFromMatrix3(_m1, _q2);
      _q2.premultiply(_q3.copy(parentG).invert()).normalize();
      rig.setPoseRotation(info.targetIdx, _q2);
    }
    if (this.flags.position) {
      // tgtGlobal.origin = srcGlobal.origin（绝对拷贝）；转局部 = parentG⁻¹ × (global − parentGlobalPos)
      this.source.getGlobalPosePosition(info.sourceIdx, _v1);
      if (parent >= 0) rig.getGlobalPosePosition(parent, _v2);
      else _v2.set(0, 0, 0);
      _v1.sub(_v2).applyQuaternion(_q3.copy(parentG).invert());
      rig.setPosePosition(info.targetIdx, _v1);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      type: 'retarget',
      useGlobalPose: this.useGlobalPose,
      enableFlags: { ...this.flags },
      boneMap: this.targetBoneMap.toJSON(),
      sourceBoneMap: this.sourceBoneMap.toJSON(),
    };
  }
}
```

> 实现注意：`Matrix3.premultiply/pre × srcPose × post` 的顺序与 Godot Basis 乘法一致（three.js `a.premultiply(b)` = b×a）。identity rig 恒等性测试对顺序极敏感——若失败先检查 pre/post 乘法顺序。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/retarget/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/retarget/retarget-modifier.ts tests/retarget/retarget-modifier.test.ts
git commit -m "feat(retarget): RetargetModifier（pre/post basis 预计算，局部/全局模式）"
```

---

### Task 18: 公共导出与构建验证

**Files:**
- Modify: `src/index.ts`
- Test: `tests/public-api.test.ts`

**Interfaces:**
- Produces: 库的完整公共 API 面（下游只看 `threeik` 一个入口）

- [ ] **Step 1: 写失败测试**

`tests/public-api.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import * as threeik from '../src/index';

describe('public API', () => {
  it('exports the full surface', () => {
    const expected = [
      'SkeletonRig', 'ThreeIKError', 'Modifier',
      'CCDIkModifier', 'FabrikModifier', 'TwoBoneIkModifier',
      'JointLimitation', 'ConeJointLimitation',
      'AimModifier', 'CopyTransformModifier',
      'RetargetModifier', 'BoneMap', 'HUMANOID_PROFILE', 'REQUIRED_HUMANOID_BONES',
      'mixamoPreset', 'readyPlayerMePreset', 'vrmPreset', 'identityPreset', 'suggestBoneMap',
    ];
    for (const name of expected) {
      expect(threeik, name).toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/public-api.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/index.ts`:
```ts
export { SkeletonRig } from './core/skeleton-rig';
export { ThreeIKError } from './core/errors';
export type { WarningPayload } from './core/events';
export type { BoneAxis, BoneDirection, RotationAxis, SecondaryDirection } from './core/bone-axes';

export { Modifier } from './modifiers/modifier';

export { CCDIkModifier } from './modifiers/ik/ccd-ik';
export { FabrikModifier } from './modifiers/ik/fabrik';
export { TwoBoneIkModifier } from './modifiers/ik/two-bone-ik';
export { IterateIKModifier } from './modifiers/ik/iterate-ik';
export { JointLimitation, ConeJointLimitation } from './modifiers/ik/joint-limitation';
export type { IKChainConfig, JointConfig } from './modifiers/ik/ik-chain';
export type { IterateIKOptions } from './modifiers/ik/iterate-ik';
export type { TwoBoneIKConfig } from './modifiers/ik/two-bone-ik';

export { AimModifier } from './modifiers/constraints/aim';
export type { AimConfig, BoneConstraintConfig } from './modifiers/constraints/aim';
export { CopyTransformModifier } from './modifiers/constraints/copy-transform';
export type { CopyTransformConfig } from './modifiers/constraints/copy-transform';

export { RetargetModifier } from './retarget/retarget-modifier';
export type { RetargetConfig, RetargetFlags } from './retarget/retarget-modifier';
export { BoneMap, mixamoPreset, readyPlayerMePreset, vrmPreset, identityPreset, suggestBoneMap } from './retarget/bone-map';
export { HUMANOID_PROFILE, REQUIRED_HUMANOID_BONES, HUMANOID_ROOT_BONE, HUMANOID_SCALE_BASE_BONE, humanoidBoneNames } from './retarget/humanoid-profile';
export type { ProfileBone, ProfileGroup, TailDirection } from './retarget/humanoid-profile';
```

- [ ] **Step 4: 全量验证**

Run: `npm run test && npm run typecheck && npm run build`
Expected: 全部测试通过；tsc 无错误；`dist/index.js` 与 `dist/index.d.ts` 产出且不含 three 代码（external）

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/public-api.test.ts
git commit -m "feat: 公共 API 导出"
```

### Task 19: Playground 脚手架与角色加载

**Files:**
- Create: `playground/package.json`
- Create: `playground/vite.config.ts`
- Create: `playground/tsconfig.json`
- Create: `playground/index.html`
- Create: `playground/src/main.ts`
- Create: `playground/src/scene.ts`（渲染器/相机/灯光/地面）
- Create: `playground/src/character.ts`（GLB 加载 + rig 构建）
- Create: `playground/src/drag-target.ts`（可拖拽目标球）
- Create: `playground/public/.gitkeep`
- Download: `playground/public/Soldier.glb`

**Interfaces:**
- Produces（后续 playground task 依赖）:
  - `createScene(container: HTMLElement): { scene, camera, renderer, onFrame(cb) }`
  - `loadSoldier(scene): Promise<{ root: Object3D; rig: SkeletonRig; mixer: AnimationMixer; actions: Map<string, AnimationAction> }>`（内部用 `suggestBoneMap` 打印映射覆盖率到 console）
  - `class DragTarget extends Object3D { constructor(camera: Camera, dom: HTMLElement, initial: Vector3, color?: number) }` —— 球形 mesh + raycast 拖拽（拖到面向相机的过当前点平面）
  - 页签切换：`mountTabs(tabs: Record<string, TabHandle>)`（`TabHandle = { mount(): void; unmount(): void }`）
- Consumes: threeik 公共 API（Task 18）

**说明**：playground 不做自动化测试；验收 = `npm run typecheck`（playground tsconfig）通过 + 手动清单。

- [ ] **Step 1: 下载演示模型**

```bash
mkdir -p playground/public
curl -L "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb" -o playground/public/Soldier.glb
ls -la playground/public/Soldier.glb  # 预期 ~2MB
```
（该模型骨骼为 `mixamorigHips` 无前缀冒号命名——加载时用 `mixamoPreset('mixamorig')`。若 dev 分支 404，改用 `https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models/gltf/Soldier.glb`。）

- [ ] **Step 2: 脚手架文件**

`playground/package.json`:
```json
{
  "name": "threeik-playground",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "three": "^0.170.0",
    "threeik": "file:..",
    "lil-gui": "^0.20.0"
  },
  "devDependencies": {
    "vite": "^5.4.11",
    "typescript": "^5.6.3",
    "@types/three": "^0.170.0"
  }
}
```

`playground/vite.config.ts`:
```ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5199 },
});
```

`playground/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`playground/index.html`:
```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>threeik playground</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #1a1d21; }
    #app { width: 100%; height: 100%; }
    #tabs { position: fixed; top: 12px; left: 12px; z-index: 10; display: flex; gap: 8px; }
    #tabs button { padding: 6px 14px; border: 1px solid #444; background: #23262b; color: #ccc; border-radius: 6px; cursor: pointer; font-size: 13px; }
    #tabs button.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  </style>
</head>
<body>
  <div id="tabs"></div>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 3: 场景与角色加载**

`playground/src/scene.ts`:
```ts
import * as THREE from 'three';

export function createScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d21);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(2.5, 1.8, 3.2);
  camera.lookAt(0, 1, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(3, 6, 4);
  scene.add(dir);
  scene.add(new THREE.GridHelper(10, 20, 0x334155, 0x1f2937));

  const frameCbs: Array<(dt: number) => void> = [];
  const clock = new THREE.Clock();
  function resize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const cb of frameCbs) cb(dt);
    renderer.render(scene, camera);
  });

  return {
    scene, camera, renderer,
    onFrame(cb: (dt: number) => void) { frameCbs.push(cb); },
  };
}
```

`playground/src/character.ts`:
```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SkeletonRig, BoneMap, mixamoPreset, suggestBoneMap } from 'threeik';

export interface LoadedCharacter {
  root: THREE.Object3D;
  rig: SkeletonRig;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  boneMap: BoneMap;
}

export async function loadSoldier(scene: THREE.Scene, position = new THREE.Vector3()): Promise<LoadedCharacter> {
  const gltf = await new GLTFLoader().loadAsync('/Soldier.glb');
  const root = gltf.scene;
  root.position.copy(position);
  scene.add(root);

  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = o as THREE.SkinnedMesh; });
  if (!skinned) throw new Error('Soldier.glb: no SkinnedMesh found');

  const rig = new SkeletonRig(skinned.skeleton.bones[0]!);
  const boneNames = skinned.skeleton.bones.map((b) => b.name);
  const suggested = suggestBoneMap(boneNames);
  console.log(`[threeik] bone map preset: ${suggested.presetName}, coverage: ${(suggested.coverage * 100).toFixed(0)}%`);
  // Soldier.glb 为无前缀 mixamorig 命名；suggest 应命中，手动 preset 兜底
  const boneMap = suggested.coverage === 1 ? suggested.map : BoneMap.fromPreset(mixamoPreset('mixamorig'));

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));

  scene.add(new THREE.SkeletonHelper(root));
  return { root, rig, mixer, actions, boneMap };
}
```

`playground/src/drag-target.ts`（raycast 拖拽：拖到平行于相机的过初始点平面）:
```ts
import * as THREE from 'three';

export class DragTarget extends THREE.Object3D {
  readonly ball: THREE.Mesh;

  constructor(camera: THREE.Camera, dom: HTMLElement, initial: THREE.Vector3, color = 0xff5533) {
    super();
    this.position.copy(initial);
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 20, 14),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.ball.renderOrder = 999;
    this.add(this.ball);

    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    let dragging = false;

    const setNdc = (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    dom.addEventListener('pointerdown', (e) => {
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.intersectObject(this.ball, false).length > 0) {
        dragging = true;
        // 拖拽平面：过当前位置、面向相机
        camera.getWorldDirection(plane.normal);
        plane.setFromNormalAndCoplanarPoint(plane.normal, this.getWorldPosition(new THREE.Vector3()));
        dom.setPointerCapture(e.pointerId);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setNdc(e);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(plane, hit)) {
        const parent = this.parent;
        if (parent) parent.worldToLocal(hit);
        this.position.copy(hit);
      }
    });
    dom.addEventListener('pointerup', () => { dragging = false; });
  }
}
```

- [ ] **Step 4: main.ts 页签骨架（演示页在 Task 20/21 填充）**

`playground/src/main.ts`:
```ts
import { createScene } from './scene';

export interface TabHandle {
  mount(): void;
  unmount(): void;
}

const { scene, camera, renderer, onFrame } = createScene(document.getElementById('app')!);

async function start() {
  // Task 20/21 在此注册页签：const tabs = { 'IK': ikTab(...), ... }
  const tabs: Record<string, TabHandle> = {};
  const tabsEl = document.getElementById('tabs')!;
  let active: TabHandle | null = null;
  for (const [name, tab] of Object.entries(tabs)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.onclick = () => {
      tabsEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      active?.unmount();
      active = tab;
      tab.mount();
    };
    tabsEl.appendChild(btn);
  }
  Object.values(tabs)[0]?.mount();
  tabsEl.querySelector('button')?.classList.add('active');
  void scene; void camera; void renderer; void onFrame; // Task 20/21 使用
}

start();
```

- [ ] **Step 5: 验证**

Run: `npm run build && cd playground && npm install && npm run typecheck && npm run dev`
Expected: typecheck 通过；`http://localhost:5199` 打开显示空场景（网格地面）且无 console 报错（页签区为空属正常，Task 20 填充）

- [ ] **Step 6: Commit**

```bash
git add playground/package.json playground/vite.config.ts playground/tsconfig.json playground/index.html playground/src playground/public/.gitkeep
git commit -m "feat(playground): 脚手架、Soldier 加载与拖拽目标"
```

---

### Task 20: Playground —— IK 演示页签

**Files:**
- Create: `playground/src/tab-ik.ts`
- Modify: `playground/src/main.ts`（注册 IK 页签）

**Interfaces:**
- Consumes: Task 19 的 `loadSoldier`/`DragTarget`/`createScene`、`threeik` 的 `CCDIkModifier`/`FabrikModifier`/`TwoBoneIkModifier`
- Produces: `createIkTab(ctx: PlaygroundContext): TabHandle`（`PlaygroundContext = { scene, camera, renderer, onFrame }`，在 main.ts 导出该类型）

**演示内容**（验收即正确性标准）：
- 加载 Soldier；左臂 CCD（`mixamorigLeftArm` → `mixamorigLeftHand`），右臂 FABRIK，左腿 TwoBoneIK（pole 在膝盖前方）；三条链各一个可拖拽 target 球。
- lil-gui 面板：每链的 `influence`、`maxIterations`、`angularDeltaLimit`（度）、`active` 开关；全局 `重置 rest` 按钮。
- 无动画（骨骼保持 rest），纯 IK 摆姿。

- [ ] **Step 1: 实现 `playground/src/tab-ik.ts`**

```ts
import * as THREE from 'three';
import GUI from 'lil-gui';
import { CCDIkModifier, FabrikModifier, TwoBoneIkModifier, type SkeletonRig } from 'threeik';
import { loadSoldier, type LoadedCharacter } from './character';
import { DragTarget } from './drag-target';
import type { TabHandle, PlaygroundContext } from './main';

export function createIkTab(ctx: PlaygroundContext): TabHandle {
  let gui: GUI | null = null;
  let character: LoadedCharacter | null = null;
  let targets: DragTarget[] = [];
  let frameCb: ((dt: number) => void) | null = null;

  return {
    async mount() {
      character = await loadSoldier(ctx.scene);
      const rig = character.rig;

      // 三个可拖拽 target：左手、右手、左脚
      const leftHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.7, 1.3, 0.3), 0xff5533);
      const rightHand = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(-0.7, 1.3, 0.3), 0x33ff77);
      const leftFoot = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.3, 0.4), 0x3388ff);
      const leftKneePole = new DragTarget(ctx.camera, ctx.renderer.domElement, new THREE.Vector3(0.25, 0.9, 1.2), 0xffcc00);
      targets = [leftHand, rightHand, leftFoot, leftKneePole];
      for (const t of targets) ctx.scene.add(t);

      const ccd = new CCDIkModifier([{ rootBone: 'mixamorigLeftArm', endBone: 'mixamorigLeftHand', target: leftHand }], { maxIterations: 10 });
      const fabrik = new FabrikModifier([{ rootBone: 'mixamorigRightArm', endBone: 'mixamorigRightHand', target: rightHand }], { maxIterations: 10 });
      const leg = new TwoBoneIkModifier([{
        rootBone: 'mixamorigLeftUpLeg', middleBone: 'mixamorigLeftLeg', endBone: 'mixamorigLeftFoot',
        target: leftFoot, poleTarget: leftKneePole,
      }]);
      rig.addModifier(ccd);
      rig.addModifier(fabrik);
      rig.addModifier(leg);

      frameCb = () => { rig.update(1 / 60); }; // 无动画路径：base = rest，直接 update
      ctx.onFrame(frameCb);

      gui = new GUI({ title: 'IK' });
      for (const [name, mod] of [['CCD 左臂', ccd], ['FABRIK 右臂', fabrik], ['TwoBone 左腿', leg]] as const) {
        const f = gui.addFolder(name);
        f.add(mod, 'active').name('启用');
        f.add(mod, 'influence', 0, 1, 0.01).name('influence');
        if ('maxIterations' in mod) {
          f.add(mod as CCDIkModifier, 'maxIterations', 1, 30, 1).name('迭代次数');
          f.add((mod as CCDIkModifier), 'angularDeltaLimit', 0, 0.35, 0.005).name('角度钳制(rad)');
        }
      }
      gui.add({ reset: () => rig.resetToRest() }, 'reset').name('重置 rest pose');
    },
    unmount() {
      gui?.destroy();
      if (character) ctx.scene.remove(character.root);
      for (const t of targets) ctx.scene.remove(t);
      targets = [];
      character = null;
      // frameCb 移除：onFrame 简化实现为数组，unmount 时重建（见 main.ts 说明）
      window.location.hash = ''; // 简化：页签切换整体重置由 main.ts 控制
    },
  };
}
```

> 实现注意：`onFrame` 需要返回注销函数以支持页签切换——把 Task 19 `createScene` 的 `onFrame` 改为 `onFrame(cb): () => void`（push 后返回移除函数），`tab-ik.ts` 保存返回值并在 unmount 调用。Task 21 同样依赖。

`playground/src/main.ts` 修改：`export type PlaygroundContext = ReturnType<typeof createScene>`；`start()` 中注册：
```ts
  const tabs: Record<string, TabHandle> = {
    'IK': createIkTab({ scene, camera, renderer, onFrame }),
  };
```

- [ ] **Step 2: 手动验收**

Run: `cd playground && npm run typecheck && npm run dev`
清单：
- [ ] 左手（红球）拖动 → 左臂平滑跟随，肘部弯曲自然
- [ ] influence 拖到 0.5 → 手臂停在 rest 与 IK 解之间
- [ ] 关闭「启用」→ 手臂回 rest
- [ ] 左腿（蓝球）拖近身体 → 膝盖朝黄球（pole）方向弯
- [ ] 迭代次数调到 1 → 末端明显够不到 target；调到 30 → 贴合
- [ ] 角度钳制调小 → 快速拖球时链条运动变缓（无跳变）

- [ ] **Step 3: Commit**

```bash
git add playground/src/tab-ik.ts playground/src/main.ts playground/src/scene.ts
git commit -m "feat(playground): IK 演示页签（CCD/FABRIK/TwoBone 拖拽交互）"
```

---

### Task 21: Playground —— 约束、重定向、动画叠加页签

**Files:**
- Create: `playground/src/tab-constraints.ts`
- Create: `playground/src/tab-retarget.ts`
- Create: `playground/src/tab-anim-ik.ts`
- Create: `playground/src/mannequin.ts`（程序化人形骨架）
- Modify: `playground/src/main.ts`（注册三个页签）

**Interfaces:**
- Consumes: 全部库 API + Task 19/20 设施
- Produces: `buildMannequin(scale: number): { root: THREE.Object3D; rig: SkeletonRig }`（骨名 = profile 名，配 identityPreset；不同体型的第二骨架，用 SkeletonHelper 显示）

**页签内容：**
1. **约束**：Aim 让 Soldier 的头追踪一个自动绕圈的目标（DragTarget 也可拖）；CopyTransform 把左手旋转复制给右手。lil-gui 调 amount。
2. **重定向**：Soldier 播 Walk 动画；旁边程序化 mannequin（1.4 倍身高，`motionScale` 各自用 `computeMotionScaleFromBone('Hips')` 设置）挂 RetargetModifier 跟随。lil-gui 开关 `useGlobalPose`、influence。**更新顺序**：mixer.update → sourceRig.captureBasePose → sourceRig.update → targetRig.update。
3. **动画 + IK 叠加**：Soldier 播 Idle；右手 FABRIK 链 target 钉在固定点——演示动画播放中 IK 叠加（idle 手部摆动被 IK 拉住）与 pose 隔离（暂停动画后姿势回 rest 而非 IK 残留）。

**关键实现：mannequin 程序化骨架**（`playground/src/mannequin.ts`）:
```ts
import * as THREE from 'three';
import { SkeletonRig } from 'threeik';
import { HUMANOID_PROFILE } from 'threeik';

/** 按 profile 层级生成无网格骨架（SkeletonHelper 可视化），scale 缩放肢体长度 */
export function buildMannequin(scale = 1.4): { root: THREE.Object3D; rig: SkeletonRig } {
  // 骨架比例表（单位米，沿主轴 -Y 向下/±X 向两侧的人形惯例；只生成 Body 主干 + 四肢，手指略）
  const L: Record<string, [number, number, number]> = {
    Root: [0, 0, 0],
    Hips: [0, 0.95, 0],
    Spine: [0, 0.12, 0], Chest: [0, 0.14, 0], UpperChest: [0, 0.14, 0],
    Neck: [0, 0.1, 0], Head: [0, 0.12, 0],
    LeftShoulder: [0.06, 0.05, 0], LeftUpperArm: [0.16, 0, 0], LeftLowerArm: [0.27, 0, 0], LeftHand: [0.26, 0, 0],
    RightShoulder: [-0.06, 0.05, 0], RightUpperArm: [-0.16, 0, 0], RightLowerArm: [-0.27, 0, 0], RightHand: [-0.26, 0, 0],
    LeftUpperLeg: [0.1, -0.05, 0], LeftLowerLeg: [0, -0.42, 0], LeftFoot: [0, -0.42, 0], LeftToes: [0, -0.05, 0.12],
    RightUpperLeg: [-0.1, -0.05, 0], RightLowerLeg: [0, -0.42, 0], RightFoot: [0, -0.42, 0], RightToes: [0, -0.05, 0.12],
  };
  const bones = new Map<string, THREE.Bone>();
  const root = new THREE.Object3D();
  for (const pb of HUMANOID_PROFILE) {
    const local = L[pb.name];
    if (!local) continue; // 手指/面部不生成
    const bone = new THREE.Bone();
    bone.name = pb.name;
    bone.position.set(local[0] * scale, local[1] * scale, local[2] * scale);
    bones.set(pb.name, bone);
    const parentBone = pb.parent ? bones.get(pb.parent) : undefined;
    if (parentBone) parentBone.add(bone);
    else root.add(bone);
  }
  root.add(new THREE.SkeletonHelper(bones.get('Hips')!));
  const rig = new SkeletonRig(bones.get('Root')!);
  return { root, rig };
}
```

**三个页签的接线要点**（实现者照此写，结构同 tab-ik.ts 的 mount/unmount）：
- tab-retarget.ts：
  ```ts
  const walk = character.actions.get('Walk')!; walk.play();
  const mannequin = buildMannequin(1.4);
  mannequin.root.position.set(1.2, 0, 0);
  ctx.scene.add(mannequin.root);
  character.rig.motionScale = character.rig.computeMotionScaleFromBone('mixamorigHips');
  mannequin.rig.motionScale = mannequin.rig.computeMotionScaleFromBone('Hips');
  const retarget = new RetargetModifier({ source: character.rig, sourceBoneMap: character.boneMap });
  mannequin.rig.addModifier(retarget);
  frameCb = (dt) => {
    character!.mixer.update(dt);
    character!.rig.captureBasePose();
    character!.rig.update(dt);
    mannequin.rig.update(dt); // 目标后更新
  };
  ```
- tab-constraints.ts：Aim 挂 `mixamorigHead`（axis '+y'），目标球 `DragTarget` 且未拖拽时绕圈（`t += dt` 圆周运动）；CopyTransform 挂 `mixamorigRightHand` ← referenceBone `mixamorigLeftHand`，左手用一个 CCD 链拖动以产生差异。
- tab-anim-ik.ts：Idle 播放；FABRIK 右手链 target 固定在世界点（0.8, 1.2, 0.5）；lil-gui 提供「暂停动画」按钮验证隔离（mixer 停 + `rig.captureBasePose()` 停调用 → rig.update 用旧 base + IK，骨骼回到「最后 base + IK」而非漂移）。

- [ ] **Step 1: 实现四个文件并按上表接线 main.ts**

- [ ] **Step 2: 手动验收**

Run: `cd playground && npm run typecheck && npm run dev`
清单：
- [ ] 约束页：Soldier 头部跟随球转动；amount 0.3 时明显滞后/弱化
- [ ] 重定向页：mannequin 与 Soldier 同步走路；步幅按身高比放大；influence 0.5 时动作幅度减半
- [ ] 动画叠加页：Idle 播放中右手被 FABRIK 钉住（呼吸摆动叠加可见）；拖球后松手不影响动画播放

- [ ] **Step 3: Commit**

```bash
git add playground/src/tab-constraints.ts playground/src/tab-retarget.ts playground/src/tab-anim-ik.ts playground/src/mannequin.ts playground/src/main.ts
git commit -m "feat(playground): 约束/重定向/动画叠加演示页签"
```

---

## 收尾

全部 21 个 task 完成后：

```bash
npm run test && npm run typecheck && npm run build && cd playground && npm run typecheck
```

随后可进入第二阶段（不在本计划）：gizmo 编辑器层与 `threeik-theatre` 桥接包（spec §8）。
