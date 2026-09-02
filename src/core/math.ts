import { Quaternion, Vector3 } from 'three';

export const CMP_EPSILON = 1e-5;
const ALMOST_ONE = 1 - CMP_EPSILON;
const TAU = Math.PI * 2;

export const isZeroApprox = (x: number): boolean => Math.abs(x) < CMP_EPSILON;
export const isEqualApprox = (a: number, b: number): boolean => {
  if (a === b) return true;
  return Math.abs(a - b) < CMP_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
};

const _axis = new Vector3();
const _v1 = new Vector3();
const _qi = new Quaternion();
const _q1 = new Quaternion();
const _q2 = new Quaternion();

/** origin + normalize(destination - origin) * length（Godot: SkeletonModifier3D::limit_length） */
export function limitLength(origin: Vector3, destination: Vector3, length: number, out: Vector3): Vector3 {
  out.copy(destination).sub(origin);
  const len = out.length();
  if (isZeroApprox(len)) return out.copy(origin);
  return out.multiplyScalar(length / len).add(origin);
}

/** Godot: get_local_pose_rotation —— 全局旋转转骨骼局部旋转 */
export function getLocalPoseRotation(parentGlobalQuat: Quaternion | null, globalQuat: Quaternion, out: Quaternion): Quaternion {
  if (!parentGlobalQuat) return out.copy(globalQuat).normalize();
  return out.copy(parentGlobalQuat).invert().multiply(globalQuat).normalize();
}

/** Godot: get_from_to_rotation。from/to 为单位向量；翻转/退化时返回 prevRot 防抖动。 */
export function getFromToRotation(from: Vector3, to: Vector3, prevRot: Quaternion, out: Quaternion): Quaternion {
  if (isEqualApprox(from.dot(to), -1)) return out.copy(prevRot);
  _axis.copy(from).cross(to);
  if (_axis.lengthSq() < CMP_EPSILON * CMP_EPSILON) return out.copy(prevRot);
  let angle = from.angleTo(to);
  if (isZeroApprox(angle)) angle = 0;
  return out.setFromAxisAngle(_axis.normalize(), angle);
}

/** Godot: get_from_to_rotation_by_axis（axis 单位向量；结果只绕 axis 旋转） */
export function getFromToRotationByAxis(from: Vector3, to: Vector3, axis: Vector3, out: Quaternion): Quaternion {
  const dot = from.dot(to);
  if (dot > ALMOST_ONE) return out.identity();
  if (dot < -ALMOST_ONE) return out.setFromAxisAngle(axis, Math.PI);
  let angle = from.angleTo(to);
  _axis.copy(from).cross(to);
  if (Math.sign(_axis.dot(axis)) < 0) angle = -angle;
  return out.setFromAxisAngle(axis, angle);
}

/** Godot: get_swing —— 提取 rotation 中垂直于 axis 的分量（swing = rot * twist^-1） */
export function getSwing(rotation: Quaternion, axis: Vector3, out: Quaternion): Quaternion {
  if (axis.lengthSq() < CMP_EPSILON * CMP_EPSILON) return out.copy(rotation);
  const rot = _q1.copy(rotation).normalize();
  const ax = _v1.copy(axis).normalize();
  const projLen = rot.x * ax.x + rot.y * ax.y + rot.z * ax.z;
  const twist = _q2.set(ax.x * projLen, ax.y * projLen, ax.z * projLen, rot.w);
  const lenSq = twist.x * twist.x + twist.y * twist.y + twist.z * twist.z + twist.w * twist.w;
  if (isZeroApprox(lenSq)) return out.copy(rot);
  twist.normalize();
  return out.copy(rot).multiply(twist.invert()).normalize();
}

/** Godot: snap_vector_to_plane —— 投影到以 planeNormal 为法线的平面，保持原长度 */
export function snapVectorToPlane(planeNormal: Vector3, vector: Vector3, out: Vector3): Vector3 {
  if (isZeroApprox(planeNormal.lengthSq())) return out.copy(vector);
  const length = vector.length();
  const n = _v1.copy(planeNormal).normalize();
  out.copy(vector).normalize();
  // slide(n) = v - n * v.dot(n)
  out.addScaledVector(n, -out.dot(n)).multiplyScalar(length);
  return out;
}

/** Godot: symmetrize_angle → [-PI, PI] */
export function symmetrizeAngle(angle: number): number {
  const a = ((angle % TAU) + TAU) % TAU;
  return a > Math.PI ? a - TAU : a;
}

/** Godot: get_roll_angle —— rotation 绕 rollAxis 的有符号滚转角 */
export function getRollAngle(rotation: Quaternion, rollAxis: Vector3): number {
  const axis = _v1.copy(rollAxis).normalize();
  const dot = rotation.x * axis.x + rotation.y * axis.y + rotation.z * axis.z;
  const rc = _q1.set(axis.x * dot, axis.y * dot, axis.z * dot, rotation.w);
  const length = Math.sqrt(rc.x * rc.x + rc.y * rc.y + rc.z * rc.z + rc.w * rc.w);
  if (length <= CMP_EPSILON) return 0;
  rc.set(rc.x / length, rc.y / length, rc.z / length, rc.w / length);
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, rc.w)));
  const direction = rc.x * axis.x + rc.y * axis.y + rc.z * axis.z > 0 ? 1 : -1;
  return symmetrizeAngle(angle * direction);
}

/** Godot: get_projected_normal —— 无限直线 a→b 上离 point 最近点指向 point 的单位向量 */
export function getProjectedNormal(a: Vector3, b: Vector3, point: Vector3, out: Vector3): Vector3 {
  const dir = _v1.copy(b).sub(a);
  const denom = dir.lengthSq();
  if (isZeroApprox(denom)) return out.set(0, 0, 0);
  const t = _axis.copy(point).sub(a).dot(dir) / denom;
  // h = a + dir * t; out = normalize(point - h)
  out.copy(point).sub(dir.multiplyScalar(t).add(a));
  const len = out.length();
  if (isZeroApprox(len)) return out.set(0, 0, 0);
  return out.multiplyScalar(1 / len);
}

/** q 作用于 v（Godot quat.xform） */
export function xformQuat(q: Quaternion, v: Vector3, out: Vector3): Vector3 {
  return out.copy(v).applyQuaternion(q);
}

/** q^-1 作用于 v（Godot quat.xform_inv） */
export function xformQuatInv(q: Quaternion, v: Vector3, out: Vector3): Vector3 {
  return out.copy(v).applyQuaternion(_qi.copy(q).invert());
}
