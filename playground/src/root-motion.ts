import * as THREE from 'three';
import { Modifier, type SkeletonRig } from 'threeik';

const _world = new THREE.Vector3();

/** 根骨位移 modifier：把 rig 根骨（髋）的姿势位置钉到 target 的世界位置。
 *  骨架编辑里移动重心用——两腿 IK 的脚 target 钉地时，髋部下移即成下蹲。
 *  仅适用 rig 根骨：worldToRigSpace 输出的是根骨父对象局部空间，即根骨姿势位置空间。 */
export class RootMotionModifier extends Modifier {
  private bone = -1;

  constructor(private readonly boneName: string, private readonly target: THREE.Object3D) {
    super();
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.bone = rig.boneIndex(this.boneName);
    if (rig.getParentIndex(this.bone) !== -1) {
      throw new Error(`RootMotionModifier: "${this.boneName}" 必须是 rig 根骨（位置写的是父对象局部空间）`);
    }
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    this.target.getWorldPosition(_world);
    rig.worldToRigSpace(_world, _world); // 模型祖先缩放（Soldier 0.01）由逆矩阵一并处理
    rig.setPosePosition(this.bone, _world);
  }

  toJSON(): Record<string, unknown> {
    return { bone: this.boneName, target: this.target.name || null };
  }
}
