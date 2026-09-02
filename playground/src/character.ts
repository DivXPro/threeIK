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
}

export async function loadSoldier(scene: THREE.Scene, position = new THREE.Vector3()): Promise<LoadedCharacter> {
  const gltf = await new GLTFLoader().loadAsync('/Soldier.glb');
  const root = gltf.scene;
  root.position.copy(position);
  scene.add(root);

  // 模型含多个 SkinnedMesh（Soldier: 身体 49 骨 + 护目镜 2 骨）——取骨架最大者，traverse 会持续覆写，勿取最后一个
  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && (!skinned || m.skeleton.bones.length > (skinned as THREE.SkinnedMesh).skeleton.bones.length)) {
      skinned = m;
    }
  });
  if (!skinned) throw new Error('Soldier.glb: no SkinnedMesh found');
  // TS 控制流收窄不追踪闭包内赋值，这里断言恢复 SkinnedMesh 类型
  const mesh = skinned as THREE.SkinnedMesh;

  const rig = new SkeletonRig(mesh.skeleton.bones[0]!);
  const boneNames = mesh.skeleton.bones.map((b) => b.name);
  const suggested = suggestBoneMap(boneNames);
  console.log(`[threeik] bone map preset: ${suggested.presetName}, coverage: ${(suggested.coverage * 100).toFixed(0)}%`);
  // Soldier.glb 为无前缀 mixamorig 命名；suggest 应命中，手动 preset 兜底
  const boneMap = suggested.coverage === 1 ? suggested.map : BoneMap.fromPreset(mixamoPreset('mixamorig'));

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));

  // helper 挂 scene（matrix 别名骨骼 matrixWorld，不可作 root 子节点）并返回引用，页签 unmount 负责移除
  const helper = new THREE.SkeletonHelper(root);
  scene.add(helper);
  return { root, rig, mixer, actions, boneMap, helper };
}
