import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { vectorFromBoneAxis, vectorFromSecondaryDirection, vectorFromRotationAxis } from '../../src/core/bone-axes';

describe('bone axes', () => {
  it('maps bone axis to vector', () => {
    expect(vectorFromBoneAxis('+y', new Vector3())).toEqual(new Vector3(0, 1, 0));
    expect(vectorFromBoneAxis('-z', new Vector3())).toEqual(new Vector3(0, 0, -1));
  });

  it('secondary direction: none → zero, custom → custom vector', () => {
    expect(vectorFromSecondaryDirection('none', undefined, new Vector3()).lengthSq()).toBe(0);
    const custom = new Vector3(1, 2, 3);
    expect(vectorFromSecondaryDirection('custom', custom, new Vector3())).toEqual(custom);
    expect(vectorFromSecondaryDirection('+x', undefined, new Vector3())).toEqual(new Vector3(1, 0, 0));
  });

  it('rotation axis: all → zero（不投影）, x/y/z → 基向量', () => {
    expect(vectorFromRotationAxis('all', undefined, new Vector3()).lengthSq()).toBe(0);
    expect(vectorFromRotationAxis('y', undefined, new Vector3())).toEqual(new Vector3(0, 1, 0));
  });
});
