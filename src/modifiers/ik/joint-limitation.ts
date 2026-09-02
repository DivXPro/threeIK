import { Quaternion, Vector3 } from 'three';

/**
 * 前向声明占位（Task 8）：ik-chain.ts 的 JointConfig/JointSetting 通过 `import type` 引用本类型。
 * Task 10 将用完整实现替换本文件（solve/makeSpace 具体实现 + ConeJointLimitation），
 * 此处签名与 Task 10 brief 的公开形状保持一致，仅用于让类型检查通过。
 */
export abstract class JointLimitation {
  abstract solve(localForward: Vector3, localRight: Vector3, rotationOffset: Quaternion, localCurrent: Vector3, out: Vector3): Vector3;
  abstract makeSpace(localForward: Vector3, localRight: Vector3, rotationOffset: Quaternion, out: Quaternion): Quaternion;
}
