import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { ConeJointLimitation } from '../../../src/modifiers/ik/joint-limitation';

describe('ConeJointLimitation', () => {
  const forward = new Vector3(0, 1, 0); // 锥轴 +Y
  const right = new Vector3(1, 0, 0);
  const offset = new Quaternion();

  it('passes through directions inside the cone', () => {
    const cone = new ConeJointLimitation(Math.PI / 2); // max 45°
    const dir = new Vector3(0.1, 1, 0).normalize(); // 距 +Y 约 5.7°
    const out = cone.solve(forward, right, offset, dir, new Vector3());
    expect(out.distanceTo(dir)).toBeLessThan(1e-5);
  });

  it('clamps directions outside the cone to its rim', () => {
    const cone = new ConeJointLimitation(Math.PI / 2); // max 45°
    const dir = new Vector3(1, 0, 0); // 距 +Y 90°
    const out = cone.solve(forward, right, offset, dir, new Vector3());
    expect(out.angleTo(forward)).toBeCloseTo(Math.PI / 4, 3);
    // 钳制方向应尽量保留原方向的侧向（+X 侧）
    expect(out.x).toBeGreaterThan(0.5);
  });

  it('handles antiparallel direction without NaN', () => {
    const cone = new ConeJointLimitation(Math.PI / 3);
    const out = cone.solve(forward, right, offset, new Vector3(0, -1, 0), new Vector3());
    expect(out.length()).toBeCloseTo(1, 5);
    expect(out.angleTo(forward)).toBeCloseTo(Math.PI / 6, 3);
  });

  it('respects rotation offset (cone axis rotated)', () => {
    const cone = new ConeJointLimitation(Math.PI / 2);
    // offset 把锥轴从 +Y 转到 +Z
    const off = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const inside = cone.solve(forward, right, off, new Vector3(0, 0, 1), new Vector3());
    expect(inside.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-4);
  });
});
