import * as THREE from 'three'

export function getWorldPosition(obj: THREE.Object3D): THREE.Vector3 {
  const v = new THREE.Vector3()
  obj.updateWorldMatrix(true, false)
  return obj.getWorldPosition(v)
}

export function getWorldQuaternion(obj: THREE.Object3D): THREE.Quaternion {
  const q = new THREE.Quaternion()
  obj.updateWorldMatrix(true, false)
  return obj.getWorldQuaternion(q)
}

/** bone から root.parent までの “Bone だけ” の鎖を返す */
export function getBoneChainToRoot(bone: THREE.Object3D, root: THREE.Object3D): THREE.Object3D[] {
  const chain: THREE.Object3D[] = []
  let cur: THREE.Object3D | null = bone
  while (cur && cur !== root.parent) {
    if ((cur as THREE.Bone).isBone) chain.push(cur)
    cur = cur.parent
  }
  return chain
}
