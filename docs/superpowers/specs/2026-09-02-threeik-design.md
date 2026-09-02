# threeik 设计文档 —— three.js 人形骨架编辑基础库

日期：2026-09-02
状态：已评审（brainstorming 阶段确认）

## 1. 背景与目标

构建一个在 three.js 运行环境中使用的人形骨架编辑基础库，架构与算法参考 Godot 4 的骨架系统（`Skeleton3D` / `SkeletonModifier3D` / `IKModifier3D` / `RetargetModifier3D` / `SkeletonProfileHumanoid`），源码位于 `/Users/huhui/Projects/godot`。

四个功能域：

1. 骨架编辑数据层（层级数据模型、rest pose 管理、序列化）
2. 骨架修改器链（IK 求解、约束，可叠加作用于骨架）
3. 骨骼重定向（retargeting）
4. 交互式编辑 gizmo（第二阶段）

**首版交付范围：核心库（1+2+3），gizmo 后置。** 另含一个不发布的 playground 演示应用。

**重要约束**：本项目后续将植入以 `/Users/huhui/Projects/theatre`（Theatre.js 魔改版，包名 `@toy-box/*`）为基础的 3D 编辑器，接口设计必须为此预留接入形状（见 §6）。

## 2. 技术栈与交付形式

- TypeScript + npm 库，包名暂定 `threeik`，ESM 输出 + 类型声明
- three.js 作为 peerDependency
- 构建：tsup；测试：vitest
- 单一包、内部分层（core / modifiers / retarget），编辑器桥接为后续独立包 `threeik-theatre`

## 3. 参考架构要点（Godot 源码考察结论）

值得移植的设计：

1. **扁平 Bone 数组 + 整数 ID + 分解存储局部姿势**（pos/quat/scale 三字段而非 Matrix4），名字→索引哈希表。
2. **nested-set 子树脏区间 + DFS 序单遍全局姿势计算**：Uint32Array ×2 + Uint8Array 脏标记，子树置脏 O(1)，只算脏段，零递归、缓存友好。
3. **Modifier 管线**：有序执行；写局部姿势立即同步全局姿势；`influence` 由管线外层做姿势插值；执行前快照基准姿势、执行后恢复——modifier 结果只影响渲染输出，与动画基准姿势隔离。
4. **链坐标系解耦求解**：IK 在纯位置数组上求解，最后统一 `cacheCurrentJointRotations`（from-to 旋转 + swing 提取）转回各骨局部旋转。CCD/FABRIK/TwoBone 实现各 ~100 行，可直接翻译。
5. **重定向 pre/post basis 预计算**，运行时每帧每骨一次矩阵乘法。
6. 编辑器端**屏幕空间 joint 拾取**（2D 距离阈值，不做 3D 碰撞体）与 get/set/commit 三段式 gizmo 协议（第二阶段用）。

需重新设计（Godot 特有，不照搬）：

1. SceneTree 帧生命周期 → 显式 `rig.update(delta)`。
2. modifier 作为子节点 + NodePath/ObjectID 缓存 → 普通数组 `rig.modifiers[]` + 极简事件发射器。
3. 属性系统（ClassDB/Variant）→ 普通对象字段 + JSON 序列化。
4. UndoRedo / physical bone 兼容层不移植。

## 4. 模块结构

```
src/
  core/                     # 数据层
    skeleton-rig.ts         # 扁平骨骼数组 + nested-set 脏标记，桥接 three.Bone 树
    bone-axes.ts            # BoneAxis/BoneDirection 枚举与骨骼轴向工具（移植自 SkeletonModifier3D）
    math.ts                 # limitLength / fromToRotation / getSwing / snapVectorToPlane / symmetrizeAngle / getRollAngle
    events.ts               # 极简事件发射器（rest-updated / pose-updated / warning）
    errors.ts               # ThreeIKError
  modifiers/
    modifier.ts             # Modifier 基类：active / influence / processModification(delta)
    modifier-chain.ts       # SkeletonRig 上的有序执行管线（快照→执行→influence 插值→同步→恢复）
    ik/
      ik-modifier.ts        # IK 基类：链配置数组、链坐标系求解→回写局部旋转
      ccd-ik.ts             # CCDIK
      fabrik.ts             # FABRIK
      two-bone-ik.ts        # 解析双骨 IK（pole target）
      joint-limitation.ts   # 关节角度限制（角锥，局部 rest 空间求解）
    constraints/
      aim.ts                # Aim 约束（look-at）
      copy-transform.ts     # CopyTransform 约束
  retarget/
    humanoid-profile.ts     # Godot SkeletonProfileHumanoid 兼容的 56 骨名表 + required 标记
    bone-map.ts             # 实际骨名 → profile 骨名映射（内置 Mixamo 等预设）
    retarget-modifier.ts    # pre/post basis 预计算 + 每帧重定向
  index.ts
playground/                 # 不发布的 Vite 演示应用（见 §7）
```

## 5. 核心数据层（SkeletonRig）

- 构造时遍历 three.js `Bone` 层级建立扁平数组：`parents: Int32Array`、`nestedSetOffset/Span: Uint32Array`、`pos/quat/scale: Float32Array×3`、`dirty: Uint8Array`，`nameToIndex: Map<string, number>`。
- **骨骼按名字寻址，永不跨帧缓存 Object3D 引用**——theatre 快照编辑器 `scene.clone()` 会断开 SkinnedMesh/Skeleton 骨骼引用，按名解析保证健壮（对应 Godot `BoneJoint{name, bone}`）。
- 姿势以分解形式存储与插值；modifier 写入的是 rig 的姿势缓冲，管线结束后一次性写回 three.js Bone（`bone.position/quaternion/scale`）。
- 全局姿势：DFS 序单遍计算，只遍历脏段；IK 求解需要的全局位置从此处读。
- 更新时机显式化：`rig.update(delta)`（独立使用），或挂 three.js `onBeforeRender`，或 theatre `updateObject` 回调（接入层决定）。
- **pose 隔离**：管线执行前快照基准姿势 → modifier 链执行（每个 modifier 写完即同步受影响子树的全局姿势）→ 按各 modifier `influence` 插值 → 写回 three.js Bone → 恢复基准姿势快照。动画系统写的是"干净"姿势，IK/约束只影响最终渲染。
- rest pose 管理：`setRestPose()` / `resetToRest()` / rest 变更触发 `rest-updated` 事件（重定向缓存重建依赖它）。

## 6. 修改器链与求解器 API

### 6.1 Modifier 基类

```ts
abstract class Modifier {
  active = true;
  influence = 1.0;             // 0~1，由管线外层做姿势插值
  abstract processModification(rig: SkeletonRig, delta: number): void;
  abstract toJSON(): ModifierConfig;   // 纯数据快照，供序列化/编辑器
}
```

### 6.2 构造时配置式

所有修改器**构造时传入完整纯数据配置**；运行时改配置 = 整体替换配置对象并重建内部缓存。配置对象即序列化快照，天然对应 theatre 的 `types.compound` sheet props 形态（可关键帧化）。

```ts
const ccd = new CCDIkModifier([
  {
    rootBone: 'LeftUpperArm',
    endBone: 'LeftHand',
    target: handTarget,              // Object3D 引用或 theatreKey 字符串（双轨）
    iterationCount: 16,
    angularDeltaLimit: Math.PI / 90, // 每迭代角度增量钳制，防跳变
    joints: {                        // 可选关节限制（rest 空间角锥）
      LeftLowerArm: { axis: 'y', limitation: elbowLimit },
    },
  },
]);
rig.addModifier(ccd);
```

链配置存骨名 + 目标引用；骨名每帧按需解析为索引，索引缓存带骨架结构版本号失效。

### 6.3 IK 求解器（移植要点）

- 基类 `IKModifier`：settings 数组（每元素一条链）；求解在**链坐标系**（纯位置数组 `chain: Vector3[]`）上进行，最后统一把链位置转回各骨局部旋转（from-to 旋转 + swing 提取 + roll 修正）。
- **CCDIK**：外层 ancestor 倒序、内层正序双层循环；每步 from-to 四元数旋转尾部坐标，再轴投影 + 限制。
- **FABRIK**：backward（末端贴 target，`limitLength` 保骨长）→ forward（首端回原位）两遍，插限制。
- **TwoBoneIK**：解析解。过远→拉直；过近→推回可达球面；否则余弦定理 + `poleTarget` 投影定 mid（两解取近 pole 者）；swing 求 root/mid 旋转，pole 平面修正 roll。**必须配 pole target**。
- **JointLimitation**：在局部 rest 空间求解角锥限制；`useRestForLimitation` 开关（rest 参考系 vs 当前 pose，含 twist/roll 修正）。
- 全部求解器支持 `angularDeltaLimit`（默认 2°/迭代）对角度增量 slerp 钳制。

### 6.4 约束

统一接口：setting = `{amount, applyBone, referenceType: 'bone'|'object', referenceBone | referenceObject}`；子类实现 `AimModifier`（look-at 单骨）与 `CopyTransformModifier`。

### 6.5 管线执行语义

`rig.modifiers[]` 按插入顺序执行；modifier 写局部姿势后立即同步该子树全局姿势（后续 modifier 读到的是已叠加结果）；执行后恢复基准姿势。

## 7. HumanoidProfile 与重定向

- **HumanoidProfile**：完整移植 `SkeletonProfileHumanoid` 56 骨名表（Root/Hips/Spine/Chest/UpperChest/Neck/Head/Eye×2/Jaw/Shoulder/UpperArm/LowerArm/Hand×2/五指 3 节×2/UpperLeg/LowerLeg/Foot/Toes×2），每骨带 `required`、`parent`、`tailDirection`、`group`（Body/Face/LeftHand/RightHand/LeftFoot/RightFoot）；`scaleBaseBone = 'Hips'`。纯 JSON 数据，编辑器 UI 可直接渲染映射面板。
- **BoneMap**：实际骨名 → profile 骨名映射表。内置 Mixamo 预设（自动剥离 `mixamorig:`/`mixamorig_` 前缀）及 VRM、ReadyPlayerMe 预设；支持手动覆盖 + 导出 JSON。
- **RetargetModifier**（挂在源 rig 上，目标是任意数量其他 rig）：初始化时对每对映射骨预计算
  - `preBasis = tgtParentGrest⁻¹ × srcParentGrest`
  - `postBasis = srcRest⁻¹ × srcParentGrest⁻¹ × tgtParentGrest × tgtRest`
  - 运行时每帧 `tgtPose.basis = pre × srcPose.basis × post`；位移按 `scaleBaseBone` 身高比缩放。
  - `useGlobalPose`（绝对/相对模式）、`enableFlags` 按 P/R/S 分量过滤。
  - rest 变更经 `rest-updated` 事件重建缓存。
- RetargetModifier 本身也是 Modifier，可插在链任意位置（如"动画 → 重定向到副角色 → 各自 IK"）。

## 8. theatre（@toy-box）接入预留

核心库保持编辑器无关，但接口形状满足以下四条：

1. 修改器配置为纯数据，对应 `types.compound` sheet props。
2. 更新时机双模式：独立 `rig.update(delta)`；接入 theatre 时挂 editable 的 `updateObject` 回调（core 值管线无中间件，`updateObject` 是全部 prop apply 之后的挂点）。
3. 骨骼按名字寻址，不缓存 Object3D 引用（快照编辑器 clone 安全）。
4. IK/重定向 target 支持 Object3D 引用或 theatreKey 字符串双轨。

第二阶段桥接包 `threeik-theatre`（不在首版范围）：

- 新增 editable 类型（bone / ikChain / retarget），`createHelper` 画骨骼线/IK 链/限制锥。
- IK 参数面板用 `studio.extend` 的 pane（core 无自定义 propEditor 注册点）。
- 屏幕空间 joint 拾取 + TransformControls 包 FK 编辑，拖动经 `studio.transaction` 写回 sheet（天然撤销/重做）。
- 若快照编辑器 clone 机制对骨架太脆，退路是自研视口 pane。

## 9. Playground

`playground/`（不发布的 Vite 应用，纯 three.js，不依赖 theatre）：

- 加载 Mixamo GLB 角色（`playground/public/`，1-2 个模型 + 动画 clip）。
- 演示页签：
  1. **IK 演示**：CCD/FABRIK/TwoBone 挂手臂/腿，鼠标拖拽 target 球，调 influence/迭代数/角度钳制。
  2. **约束演示**：Aim 让头追踪目标；CopyTransform 同步骨骼。
  3. **重定向演示**：一段 Mixamo 动画同时驱动两个不同体型角色，开关全局/局部模式对比。
  4. **播放 + IK 叠加**：动画播放中叠加脚 IK，展示 pose 隔离。
- `lil-gui` 参数面板。playground 同时是核心库的冒烟测试场：每个 solver API 必须能在此直观验证。

## 10. 错误处理与测试

**错误处理**：

- 骨名不存在、链成环、root 不是 end 祖先等配置错误 → 抛带骨名/链索引的描述性 `ThreeIKError`。
- 求解数值问题（零长骨骼、NaN 目标）→ 跳过该迭代并触发一次 `warning` 事件，不刷屏不崩溃。
- 校验集中在配置 setter / `rig.attach()`，求解热路径零分配零检查。

**测试（vitest）**：

- math 工具（fromToRotation/getSwing/snapVectorToPlane 等，对照 Godot 实现用例）。
- nested-set 脏标记正确性（子树置脏/全局姿势只算脏段）。
- CCD/FABRIK/TwoBone 收敛性：固定链 + 固定 target，断言末端误差 < ε；过远/过近边界用例。
- 重定向 pre/post basis 恒等性：源=目标时输出原姿势；rest 变更后缓存重建。
- playground 手动验收；首版不做浏览器自动化测试（YAGNI）。

## 11. 里程碑

1. **M1 数据层**：SkeletonRig + math 工具 + 事件 + 错误体系 + 单测。
2. **M2 修改器链**：Modifier 基类 + 管线 + CCD/FABRIK + TwoBoneIK + JointLimitation + 约束。
3. **M3 重定向**：HumanoidProfile + BoneMap（Mixamo/VRM/RPM 预设）+ RetargetModifier。
4. **M4 Playground**：四个演示页签。
5. **后续（不在本 spec）**：gizmo 编辑器层 + `threeik-theatre` 桥接包。
