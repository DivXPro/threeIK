import type { ControlKindFactory, ControlSpecBase } from './types';

const customKinds = new Map<string, ControlKindFactory>();

/**
 * 注册自定义控制点类型。spec.kind 先查这里（可覆盖内置），再落到内置 root/limb/lookAt/chain。
 * 工厂拿到与内置 kind 相同的 ControlBuildContext（rig/骨骼查询/facing/默认值），
 * 返回 BuiltControl 后即纳入统一的排序、首解捕获、逐帧更新与清理管线。
 */
export function registerControlKind<S extends ControlSpecBase>(kind: string, factory: ControlKindFactory<S>): void {
  customKinds.set(kind, factory as ControlKindFactory);
}

export function resolveCustomControlKind(kind: string): ControlKindFactory | undefined {
  return customKinds.get(kind);
}
