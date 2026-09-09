# threeik（npm：`@dreamerbird/threeik`）

three.js 的人形骨架编辑基础库。骨架数据层采用扁平化分解存储（rest / base / work 三套局部姿势 + 懒计算全局姿势缓存），modifier 管线提供 CCD / FABRIK / Two-Bone 三种 IK 求解器、关节角锥限制（`ConeJointLimitation`）、Aim / CopyTransform 约束，以及基于骨名映射的动画重定向（`RetargetModifier`，内置 Mixamo / VRM / ReadyPlayerMe 预设）。算法与架构参考 Godot 4 的 SkeletonModifier3D / SkeletonIK3D 体系移植。

## 安装

```bash
npm i @dreamerbird/threeik three
```

`three` 为 peer 依赖（>= 0.160.0）；除此之外无运行时依赖。

## 最小用例

```ts
import { SkeletonRig, CCDIkModifier } from '@dreamerbird/threeik';
import { Object3D } from 'three';

// rootBone：骨架根 Bone（v1 假定单根人形骨架）
const rig = new SkeletonRig(rootBone);

// IK target 是场景里的普通 Object3D，拖动它即可驱动骨骼
const target = new Object3D();
scene.add(target);

rig.addModifier(new CCDIkModifier([
  { rootBone: 'UpperArm', endBone: 'Hand', target },
]));

function animate(dt: number) {
  mixer?.update(dt);      // 1. 动画先写入骨骼
  rig.captureBasePose();  // 2. 采基准姿势
  rig.update(dt);         // 3. modifier 管线求解并写回骨骼
  renderer.render(scene, camera); // 4. 渲染
}
```

## 更新顺序契约

每帧严格按以下顺序调用：

1. `mixer.update(dt)` —— AnimationMixer 先把动画姿势写入骨骼；
2. `rig.captureBasePose()` —— 把骨骼当前 TRS 采为基准姿势（base）；
3. `rig.update(dt)` —— modifier 管线在 base 上求解（base 与工作姿势隔离，求解结果不累积）；
4. `renderer.render(...)`。

漏调 `captureBasePose()` 时 base 停在旧帧：无动画的纯 FK 编辑场景可以不调（base 即 rest），接了 AnimationMixer 的场景每帧必须调用，否则 modifier 在过期基准上求解。

重定向时**目标 rig 在源 rig 之后 `update`**（`RetargetModifier` 读取源 rig 的当前姿势）；顺序反了结果滞后一帧。

## target 双轨解析

链/约束配置中的 `target`、`poleTarget`、`referenceObject` 均接受两种形式：

- `Object3D` 直接引用；
- 字符串 key，经 `rig.targetResolver = (key) => Object3D | null` 解析（供 theatre 等接入层按名字注入场景对象）。

未解析到时该链/约束**本帧跳过**，并通过 `warnOnce` 触发一次 `warning` 事件（`rig.on('warning', ({ key, message }) => ...)`），不刷屏不崩溃；target 位置/四元数为 NaN 时同样守卫跳过。

## rebind 注意

编辑骨架树（增删 Bone、改层级、重命名，或 theatre 快照编辑器 clone 场景）后，调用 `rig.rebind(newRoot)`：rig 重建全部内部缓冲（骨列表、父子索引、rest 姿势），并逐个 detach/attach 已挂载的 modifier，**重建其索引与链缓存**。注意 rebind 以骨骼**当前 TRS** 为新的 rest pose。

## 配置替换惯例

modifier 配置在构造时整体传入；运行时改配置的惯例是**整体替换**：

```ts
rig.removeModifier(oldModifier);
rig.addModifier(new CCDIkModifier(newChains));
```

`IterateIKModifier`（CCD / FABRIK 的基类）另有 `setChains()` 可原地替换链配置。同一 modifier 实例重复 `addModifier` 会被忽略。

## 接入指南：控制点装配（@dreamerbird/threeik/controls）

核心层之上是交互编辑层：声明式控制点装配器，入口为子路径 `@dreamerbird/threeik/controls`。一句话模型：**球/标记 = 控制对象（常显），箭头/环 = 操纵器（仅选中显示）**。

```ts
import { createSkeletonControls } from '@dreamerbird/threeik/controls';

const ctl = createSkeletonControls({
  rig, scene, camera,
  dom: renderer.domElement,   // 指针事件宿主
  facing,                     // 角色朝向（世界系），缺省 (0,0,-1)
  controls: [
    { kind: 'root', name: 'hips', bone: 'Hips', rotation: true },
    { kind: 'limb', name: 'armL', rootBone: 'LeftArm', middleBone: 'LeftForeArm', endBone: 'LeftHand',
      endRotation: true, rootRotation: true, pole: { color: 0xccff66, position: [0.38, 0.98, -0.2] } },
    { kind: 'chain', name: 'spine', rootBone: 'Spine', endBone: 'Neck' },
    { kind: 'bone', name: 'chest', bone: 'Spine2' },
    { kind: 'lookAt', name: 'head', rootBone: 'Neck', endBone: 'Head', position: [0, 1.7, 0.9] },
  ],
});

// 每帧：接在上面「更新顺序契约」的第 3 步之后
ctl.update(); // 携带 → 环跟随 → 引导线 → 操纵器屏幕恒定大小
```

五种内置 kind：`root`（重心）、`limb`（四肢 TwoBone + pole 肘/膝朝向）、`chain`（脊柱 FABRIK）、`bone`（直接掰骨 FK）、`lookAt`（注视 CCD）。同骨架上多个控制点的 modifier 求解顺序由装配器按骨深度自动排（浅的先解）。`ctl.get(name)` 取句柄：钳制参数（`setReachScale`/`setKeepAlive` 等）、`setActive` 开关都在句柄上。自定义控制点用 `registerControlKind` 注册，走同一装配管线。

### 换模型

库不绑定模型，任何单根骨骼树都行。换模型 = 重建：

1. 加载新模型，`new SkeletonRig(newRoot)`（拓扑变更用 `rig.rebind`，注意它以当前 TRS 为新 rest）；
2. 控制点按**骨骼名**声明，把新模型的骨名填进 spec——Mixamo / VRM / ReadyPlayerMe 的命名差异可用重定向模块的预设与 `suggestBoneMap` 解析；
3. `ctl.dispose()` 后用新 rig 重新 `createSkeletonControls`；
4. 模型朝向不是 -Z 时传 `facing`。

### 初始姿势

- spec 的 `position` 设控制球初始世界位置，装配首解即把骨架解过去（手球放低 = 手臂下垂）；不设则保持 rest；
- rest pose = rig 构造/rebind 时刻骨骼的 TRS：创建 rig 前把骨骼预摆到目标姿势，它即成为 rest（`rig.resetToRest()` 回到它）。

### 操纵器模式与选中

Maya 式 W/E：`ctl.setManipulatorMode('move' | 'rotate')`——W = 位置球 + 轴箭头，E = 旋转环；双通道控制点的球在 E 退化为可点标记（大小不变，只切可拖性）。选中机制：只有选中的控制点显示操纵器，点操纵器自动选中，点空白失焦。子选中（`'armL:elbow'` / `'armL:root'`）让肘部/肩部成为独立选中目标。纯旋转控制点（bone、肩/髋根环）选中即出环，不看 W/E。

### 颜色与外观

- 声明期：spec 的 `color`（球）、`pole.color`、`ballRadius`、`ringRadius`；
- 运行期换色：`target.setColor(hex)` / `pole.setColor(hex)`（经句柄取到：`ctl.get('armL')!.target.setColor(0xff0000)`）；选中高亮中保持亮黄，取消选中落回新色；
- 视觉语言常量：`MARKER_SCALE`（常驻标记球身份尺寸）、`MARKER_SELECTED_COLOR`（选中高亮黄）——自定义 kind 做标记球时直接引用，观感与内置一致。

## 已知限制

- v1 假定**单根人形骨架**（多根骨 / 多棵骨树未支持）。
- `CopyTransformModifier` 不支持全局 scale 拷贝（`copyScale` 仅警告并忽略）。
- `TwoBoneIkModifier` 要求 middle 是 root 的直接子骨、end 是 middle 的直接子骨（attach 时校验）。

## Playground

```bash
cd playground
npm install
npm run fetch-assets   # 下载 Soldier.glb（three.js 官方示例模型，被 .gitignore 排除不入库）
npm run dev            # http://localhost:5199
```

四个页签：IK、约束、重定向、动画+IK，对应库的四条主用法路径。
