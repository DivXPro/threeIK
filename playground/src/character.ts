import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SkeletonRig, BoneMap, mixamoPreset, suggestBoneMap } from 'threeik';

export interface LoadedCharacter {
  root: THREE.Object3D;
  rig: SkeletonRig;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  boneMap: BoneMap;
  helper: THREE.SkeletonHelper;
  /** 角色世界朝向（单位向量）：方向锥轴/pole 摆位的参照 */
  facing: THREE.Vector3;
}

// X Bot（three.js 示例模型，Mixamo 导出）：灰白机器人、四肢细长无装备遮挡，关节朝向一眼可辨，
// 比迷彩 Soldier 更容易判断姿势对错。模型局部前方 = +Z，出厂即面朝 +Z 相机，无需旋转。
const MODEL_URL = '/Xbot.glb';
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);

export async function loadCharacter(scene: THREE.Scene, position = new THREE.Vector3()): Promise<LoadedCharacter> {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const root = gltf.scene;
  root.position.copy(position);
  // X Bot 是 Mixamo 官方下载命名：骨名带「mixamorig:」前缀（冒号）；threeik 骨名映射与
  // 控制点声明统一用无前缀名——载入时剥掉冒号，动画轨道名同步改以保持绑定
  root.traverse((o) => { o.name = o.name.replace('mixamorig:', 'mixamorig'); });
  for (const clip of gltf.animations) {
    for (const track of clip.tracks) track.name = track.name.replace('mixamorig:', 'mixamorig');
  }
  scene.add(root);

  // 模型含多个 SkinnedMesh——取骨架最大者，traverse 会持续覆写，勿取最后一个
  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && (!skinned || m.skeleton.bones.length > (skinned as THREE.SkinnedMesh).skeleton.bones.length)) {
      skinned = m;
    }
  });
  if (!skinned) throw new Error(`${MODEL_URL}: no SkinnedMesh found`);
  // TS 控制流收窄不追踪闭包内赋值，这里断言恢复 SkinnedMesh 类型
  const mesh = skinned as THREE.SkinnedMesh;

  const rig = new SkeletonRig(mesh.skeleton.bones[0]!);
  const boneNames = mesh.skeleton.bones.map((b) => b.name);
  const suggested = suggestBoneMap(boneNames);
  console.log(`[threeik] bone map preset: ${suggested.presetName}, coverage: ${(suggested.coverage * 100).toFixed(0)}%`);
  // 骨名已剥冒号为无前缀 mixamorig 命名；suggest 应命中，手动 preset 兜底
  const boneMap = suggested.coverage === 1 ? suggested.map : BoneMap.fromPreset(mixamoPreset('mixamorig'));

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));

  const facing = LOCAL_FORWARD.clone().applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));

  // helper 挂 scene（matrix 别名骨骼 matrixWorld，不可作 root 子节点）并返回引用，页签 unmount 负责移除
  const helper = new THREE.SkeletonHelper(root);
  scene.add(helper);
  return { root, rig, mixer, actions, boneMap, helper, facing };
}
