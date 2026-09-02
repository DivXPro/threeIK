import { Matrix4, Quaternion, Vector3 } from 'three';
import { CMP_EPSILON, isZeroApprox } from '../../core/math';

const ALMOST_ONE = 1 - CMP_EPSILON;
const UP = new Vector3(0, 1, 0);
// 模块临时量（一次性分配，求解路径零分配）。占用约定（防别名冲突）：
// - makeSpace:       _v1(axisY) _v2(axisX) _v3(axisZ) _q1(offset 暂存) _m
// - solve:           _q2(space，须跨 solveDirection 存活) _q3(space 逆暂存) _v3(dir，须跨 solveDirection 存活)
// - solveDirection:  _v1 _v2 _v4 _q1；`direction` 只读（调用方经 _v3 传入），不得写 _v3/_q2/_q3
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
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
    const space = this.makeSpace(localForward, localRight, rotationOffset, _q2);
    // dir 用 _v3、逆矩阵用 _q3：solveDirection 会覆写 _v1/_v2/_q1，space(_q2) 必须存活到最后一步
    const dir = _v3.copy(localCurrent).normalize().applyQuaternion(_q3.copy(space).invert());
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
    const centerAxis = _v1.set(0, 1, 0);
    const currentAngle = direction.angleTo(centerAxis);
    const maxAngle = this.angle * 0.5;
    if (currentAngle <= maxAngle) return out.copy(direction);

    // 完全反向：任取垂直轴（Godot get_any_perpendicular；取确定性的 +X）
    const planeNormal = _v2;
    if (Math.abs(currentAngle - Math.PI) < CMP_EPSILON) {
      planeNormal.set(1, 0, 0); // +Y 的任一垂直向量
    } else {
      planeNormal.copy(centerAxis).cross(direction).normalize();
    }
    // 默认：centerAxis 绕 planeNormal 转 maxAngle
    out.copy(centerAxis).applyQuaternion(_q1.setFromAxisAngle(planeNormal, maxAngle));
    // 若 direction 在锥外但有侧向分量：取 direction 侧向、夹角 maxAngle 的方向（保留方向性）
    // projection 用 _v4：centerAxis(_v1)/direction 在下面的叉积与输出中仍需读取，不可覆写
    const projection = _v4.copy(direction).addScaledVector(centerAxis, -direction.dot(centerAxis));
    if (projection.lengthSq() > CMP_EPSILON) {
      const sideDir = projection.normalize();
      planeNormal.copy(centerAxis).cross(sideDir); // 默认旋转已写入 out，planeNormal 可复用
      if (planeNormal.lengthSq() > CMP_EPSILON) {
        out.copy(centerAxis).applyQuaternion(_q1.setFromAxisAngle(planeNormal.normalize(), maxAngle));
      }
    }
    return out.normalize();
  }
}
