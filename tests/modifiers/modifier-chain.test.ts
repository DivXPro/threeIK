import { describe, it, expect } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { SkeletonRig } from '../../src/core/skeleton-rig';
import { Modifier } from '../../src/modifiers/modifier';

class RotateBoneModifier extends Modifier {
  constructor(private bone: string, private angle: number) {
    super();
  }
  processModification(rig: SkeletonRig): void {
    const i = rig.boneIndex(this.bone);
    const prev = rig.getPoseRotation(i, new Quaternion());
    const delta = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), this.angle);
    rig.setPoseRotation(i, prev.multiply(delta));
  }
  toJSON() {
    return { type: 'rotate-bone', bone: this.bone, angle: this.angle };
  }
}

function buildRig() {
  const hips = new Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
  const spine = new Bone(); spine.name = 'Spine'; spine.position.set(0, 0.1, 0);
  hips.add(spine);
  return { rig: new SkeletonRig(hips), spine };
}

describe('modifier pipeline', () => {
  it('applies modifier to bones on update', () => {
    const { rig, spine } = buildRig();
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 2));
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-5);
  });

  it('influence blends pose (0.5 → half angle)', () => {
    const { rig, spine } = buildRig();
    const m = new RotateBoneModifier('Spine', Math.PI / 2);
    m.influence = 0.5;
    rig.addModifier(m);
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-3);
  });

  it('inactive modifier is skipped', () => {
    const { rig, spine } = buildRig();
    const m = new RotateBoneModifier('Spine', Math.PI / 2);
    m.active = false;
    rig.addModifier(m);
    rig.update(0.016);
    expect(spine.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('base pose stays clean across updates（无累积：连续两次 update 结果一致）', () => {
    const { rig, spine } = buildRig();
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 2));
    rig.update(0.016);
    const first = spine.quaternion.clone();
    rig.update(0.016);
    expect(spine.quaternion.angleTo(first)).toBeLessThan(1e-6);
    // base 缓冲未被污染
    expect(rig.getBasePoseRotation(1, new Quaternion()).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('modifiers run in insertion order（后执行者读到前者的结果）', () => {
    const { rig, spine } = buildRig();
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 4));
    rig.addModifier(new RotateBoneModifier('Spine', Math.PI / 4));
    rig.update(0.016);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-5);
  });

  it('removeModifier detaches', () => {
    const { rig, spine } = buildRig();
    const m = new RotateBoneModifier('Spine', 1);
    rig.addModifier(m);
    rig.removeModifier(m);
    rig.update(0.016);
    expect(spine.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('adding the same modifier instance twice is a no-op', () => {
    const { rig } = buildRig();
    const m = new RotateBoneModifier('Spine', 1);
    rig.addModifier(m);
    rig.addModifier(m);
    expect(rig.getModifiers().length).toBe(1);
  });
});
