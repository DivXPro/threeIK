import * as THREE from 'three';

/**
 * 测量 IK 链的可达半径：沿直系后裔路径 rootName→endName 累加各段骨长。
 * 注意必须用世界空间距离——模型可能有祖先缩放（Soldier 的 Character 节点 scale=0.01，
 * 骨局部坐标是厘米量级，直接取 position.length() 会得到放大 100 倍的半径）。
 * 返回链根骨（钳制球心以其世界位置为准）与可达半径；链不存在返回 null。
 */
export function measureChain(
  sceneRoot: THREE.Object3D,
  rootName: string,
  endName: string,
): { rootBone: THREE.Object3D; reach: number } | null {
  const rootBone = sceneRoot.getObjectByName(rootName);
  if (!rootBone) return null;

  const findDescendant = (node: THREE.Object3D): THREE.Object3D | null => {
    for (const child of node.children) {
      if (child.name === endName) return child;
      const found = findDescendant(child);
      if (found) return found;
    }
    return null;
  };
  const endBone = findDescendant(rootBone);
  if (!endBone) return null;

  // end 沿 parent 回溯必经 root（直系后裔），逐段累加世界距离
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let reach = 0;
  let node: THREE.Object3D = endBone;
  while (node !== rootBone) {
    node.getWorldPosition(a);
    node.parent!.getWorldPosition(b);
    reach += a.distanceTo(b);
    node = node.parent!;
  }
  return { rootBone, reach };
}
