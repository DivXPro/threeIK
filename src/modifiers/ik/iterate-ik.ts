import { Object3D, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { Modifier } from '../modifier';
import { IKChain, type IKChainConfig } from './ik-chain';

export interface IterateIKOptions {
  maxIterations?: number;
  minDistance?: number;
  angularDeltaLimit?: number;
}

const _targetPos = new Vector3();

/** Godot: IterateIK3D 的求解流程（iterate_ik_3d.cpp 567–615 行） */
export abstract class IterateIKModifier extends Modifier {
  protected chains: IKChain[] = [];
  private chainConfigs: IKChainConfig[];

  maxIterations: number;
  minDistance: number;
  angularDeltaLimit: number;

  constructor(chains: IKChainConfig[], options?: IterateIKOptions) {
    super();
    this.chainConfigs = chains;
    this.maxIterations = options?.maxIterations ?? 4;
    this.minDistance = options?.minDistance ?? 0.001;
    this.angularDeltaLimit = options?.angularDeltaLimit ?? Math.PI / 90; // 2°
  }

  override attach(rig: SkeletonRig): void {
    super.attach(rig);
    this.setChains(this.chainConfigs);
  }

  /** 构造时配置式：运行时整体替换配置并重建链缓存 */
  setChains(configs: IKChainConfig[]): void {
    this.chainConfigs = configs;
    if (!this.rig) return;
    this.chains = configs.map((c) => new IKChain(this.rig!, c));
  }

  getChain(i: number): IKChain {
    return this.chains[i]!;
  }

  get chainCount(): number {
    return this.chains.length;
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    const minDistSq = this.minDistance * this.minDistance;
    for (const chain of this.chains) {
      chain.initJoints(rig);
      const destination = this.resolveTarget(rig, chain);
      if (!destination) continue; // 未解析到 target：本帧跳过
      chain.cacheCurrentJointRotations(rig); // 全量，检测链外父骨姿势变化
      this.processJoints(rig, chain, destination, minDistSq);
      // 求解结果写回工作姿势（Godot: set_bone_pose_rotation）
      for (let i = 0; i < chain.solverInfos.length; i++) {
        const info = chain.solverInfos[i];
        if (!info || info.length === 0) continue;
        rig.setPoseRotation(chain.joints[i]!, info.currentLpose);
      }
      chain.simulated = true;
    }
  }

  /** 防振荡：已模拟过且已达标的链不再迭代（translate _process_joints） */
  private processJoints(rig: SkeletonRig, chain: IKChain, destination: Vector3, minDistSq: number): void {
    let distSq = Infinity;
    let iteration = 0;
    if (chain.simulated) {
      distSq = chain.getChainEnd().distanceToSquared(destination);
    }
    while (distSq > minDistSq && iteration < this.maxIterations) {
      this.solveIteration(rig, chain, destination);
      chain.cacheCurrentJointRotations(rig, this.angularDeltaLimit);
      distSq = chain.getChainEnd().distanceToSquared(destination);
      iteration++;
    }
  }

  protected resolveTarget(rig: SkeletonRig, chain: IKChain): Vector3 | null {
    const t = chain.config.target;
    const obj = typeof t === 'string' ? rig.targetResolver?.(t) : t;
    if (!obj) {
      rig.warnOnce(`ik-target-missing:${String(t)}`, `IK target not resolvable: ${String(t)}`);
      return null;
    }
    obj.getWorldPosition(_targetPos);
    if (Number.isNaN(_targetPos.x + _targetPos.y + _targetPos.z)) {
      rig.warnOnce('ik-target-nan', `IK target position is NaN: ${String(t)}`);
      return null;
    }
    return rig.worldToRigSpace(_targetPos, _targetPos);
  }

  protected abstract solveIteration(rig: SkeletonRig, chain: IKChain, destination: Vector3): void;

  toJSON(): Record<string, unknown> {
    return {
      chains: this.chainConfigs.map((c) => ({
        ...c,
        target: typeof c.target === 'string' ? c.target : c.target.name || null,
        joints: Object.fromEntries(
          Object.entries(c.joints ?? {}).map(([k, v]) => [k, { ...v, limitation: v.limitation ? { type: 'cone', angle: (v.limitation as { angle?: number }).angle } : null }]),
        ),
      })),
      maxIterations: this.maxIterations,
      minDistance: this.minDistance,
      angularDeltaLimit: this.angularDeltaLimit,
    };
  }
}
