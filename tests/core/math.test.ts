import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  limitLength, getFromToRotation, getFromToRotationByAxis, getSwing,
  snapVectorToPlane, symmetrizeAngle, getRollAngle, getProjectedNormal,
} from '../../src/core/math';

const expectVecClose = (v: Vector3, x: number, y: number, z: number, eps = 1e-4) => {
  expect(v.x).toBeCloseTo(x, 4);
  expect(v.y).toBeCloseTo(y, 4);
  expect(v.z).toBeCloseTo(z, 4);
};

describe('limitLength', () => {
  it('clamps destination to length from origin', () => {
    const out = new Vector3();
    limitLength(new Vector3(0, 0, 0), new Vector3(0, 0, 5), 2, out);
    expectVecClose(out, 0, 0, 2);
  });
});

describe('getFromToRotation', () => {
  it('rotates +X onto +Y (90 deg about +Z)', () => {
    const q = getFromToRotation(new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Quaternion(), new Quaternion());
    const v = new Vector3(1, 0, 0).applyQuaternion(q);
    expectVecClose(v, 0, 1, 0);
  });

  it('returns prevRot for antiparallel vectors', () => {
    const prev = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7);
    const out = new Quaternion();
    getFromToRotation(new Vector3(1, 0, 0), new Vector3(-1, 0, 0), prev, out);
    expect(out.angleTo(prev)).toBeLessThan(1e-6);
  });
});

describe('getFromToRotationByAxis', () => {
  it('rotates +X to +Y by +90deg about +Z', () => {
    const q = getFromToRotationByAxis(new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Quaternion());
    expectVecClose(new Vector3(1, 0, 0).applyQuaternion(q), 0, 1, 0);
  });

  it('is identity for parallel vectors', () => {
    const q = getFromToRotationByAxis(new Vector3(1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Quaternion());
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('uses axis for PI rotation when antiparallel', () => {
    const q = getFromToRotationByAxis(new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Quaternion());
    expectVecClose(new Vector3(1, 0, 0).applyQuaternion(q), -1, 0, 0);
  });

  it('is identity for zero-length from', () => {
    // Godot scene/3d/skeleton_modifier_3d.cpp:297 get_from_to_rotation_by_axis：
    // 零长 from → dot=0（不触发 ALMOST_ONE 早退）→ angle_to = atan2(|cross|, dot)
    // （core/math/vector3.h:356-358）= atan2(0, 0) = 0 → Quaternion(axis, 0) = identity。
    // three.js angleTo 对零长有 denominator===0 → π/2 守卫（Vector3.js:523-537），需显式早退对齐。
    const q = getFromToRotationByAxis(new Vector3(0, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Quaternion());
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('is identity for zero-length to', () => {
    // 同上：Godot skeleton_modifier_3d.cpp:297 + vector3.h:356-358，atan2(0, 0) = 0 → identity。
    const q = getFromToRotationByAxis(new Vector3(0, 1, 0), new Vector3(0, 0, 0), new Vector3(0, 0, 1), new Quaternion());
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });
});

describe('getSwing', () => {
  it('extracts swing component about axis', () => {
    const twist = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const swing = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    const rot = new Quaternion().copy(swing).multiply(twist); // swing * twist
    const out = getSwing(rot, new Vector3(0, 1, 0), new Quaternion());
    expect(out.angleTo(swing)).toBeLessThan(1e-4);
  });
});

describe('snapVectorToPlane', () => {
  it('projects onto plane keeping length', () => {
    const out = snapVectorToPlane(new Vector3(0, 0, 1), new Vector3(1, 1, 1), new Vector3());
    expectVecClose(out, 1, 1, 0);
  });

  it('returns vector unchanged for zero normal', () => {
    const out = snapVectorToPlane(new Vector3(0, 0, 0), new Vector3(1, 2, 3), new Vector3());
    expectVecClose(out, 1, 2, 3);
  });
});

describe('symmetrizeAngle', () => {
  it('wraps to [-PI, PI]', () => {
    expect(symmetrizeAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 6);
    expect(symmetrizeAngle(Math.PI / 4)).toBeCloseTo(Math.PI / 4, 6);
    expect(symmetrizeAngle(Math.PI * 2.25)).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('getRollAngle', () => {
  it('returns signed roll around axis', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    expect(getRollAngle(q, new Vector3(1, 0, 0))).toBeCloseTo(0.7, 5);
    expect(getRollAngle(q, new Vector3(-1, 0, 0))).toBeCloseTo(-0.7, 5);
  });
});

describe('getProjectedNormal', () => {
  it('returns nearest normal from line to point', () => {
    const out = getProjectedNormal(new Vector3(0, 0, 0), new Vector3(0, 0, 1), new Vector3(1, 2, 3), new Vector3());
    expectVecClose(out, 1 / Math.sqrt(5), 2 / Math.sqrt(5), 0);
  });

  it('returns zero for degenerate line', () => {
    const out = getProjectedNormal(new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(0, 0, 0), new Vector3());
    expectVecClose(out, 0, 0, 0);
  });
});
