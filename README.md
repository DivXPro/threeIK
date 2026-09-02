# threeik

three.js 的人形骨架编辑基础库。骨架数据层采用扁平化分解存储（rest / base / work 三套局部姿势 + 懒计算全局姿势缓存），modifier 管线提供 CCD / FABRIK / Two-Bone 三种 IK 求解器、关节角锥限制（`ConeJointLimitation`）、Aim / CopyTransform 约束，以及基于骨名映射的动画重定向（`RetargetModifier`，内置 Mixamo / VRM / ReadyPlayerMe 预设）。算法与架构参考 Godot 4 的 SkeletonModifier3D / SkeletonIK3D 体系移植。

## 安装

```bash
npm i threeik three
```

`three` 为 peer 依赖（>= 0.160.0）；除此之外无运行时依赖。

## 最小用例

```ts
import { SkeletonRig, CCDIkModifier } from 'threeik';
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
