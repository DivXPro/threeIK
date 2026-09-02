import type { SkeletonRig } from '../core/skeleton-rig';

export abstract class Modifier {
  active = true;
  /** 0~1，由管线在 modifier 执行后做姿势插值（Godot SkeletonModifier3D.influence） */
  influence = 1;

  protected rig: SkeletonRig | null = null;

  /** rig.addModifier 时调用；子类重写以构建骨索引/链缓存。禁止在构造器里碰 rig。 */
  attach(rig: SkeletonRig): void {
    this.rig = rig;
  }

  detach(): void {
    this.rig = null;
  }

  abstract processModification(rig: SkeletonRig, delta: number): void;

  /** 纯数据快照（theatre sheet props / 序列化共用） */
  abstract toJSON(): Record<string, unknown>;
}
