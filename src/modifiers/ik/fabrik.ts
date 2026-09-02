import { Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { isZeroApprox, limitLength } from '../../core/math';
import type { IKChain } from './ik-chain';
import { IterateIKModifier } from './iterate-ik';

const _v = new Vector3();
const _v2 = new Vector3(); // 专用：getProjectedRotation 的输出（见 applyJointConstraints 调用处注释）

/** Godot: FABRIK3D::_solve_iteration（fabr_ik_3d.cpp 33–87 行） */
export class FabrikModifier extends IterateIKModifier {
  protected solveIteration(rig: SkeletonRig, chain: IKChain, destination: Vector3): void {
    const jointSize = chain.joints.length;

    // Backward：末端贴 target，逐骨向 root 拉（保骨长）
    let first = true;
    for (let i = jointSize - 1; i >= 0; i--) {
      const info = chain.solverInfos[i];
      if (!info || isZeroApprox(info.length)) continue;
      const head = i;
      const tail = i + 1;
      if (first) {
        chain.updateChainCoordinateBw(rig, tail, destination);
        first = false;
      }
      limitLength(chain.chain[tail]!, chain.chain[head]!, info.length, _v);
      chain.updateChainCoordinateBw(rig, head, _v);
      this.applyJointConstraints(rig, chain, head, tail, true);
    }

    // Forward：首端回原位，逐骨向末端推
    first = true;
    for (let i = 0; i < jointSize; i++) {
      const info = chain.solverInfos[i];
      if (!info || isZeroApprox(info.length)) continue;
      const head = i;
      const tail = i + 1;
      if (first) {
        rig.getGlobalPosePosition(chain.joints[head]!, _v); // root 固定在当前全局姿势
        chain.updateChainCoordinateFw(rig, head, _v);
        first = false;
      }
      limitLength(chain.chain[head]!, chain.chain[tail]!, info.length, _v);
      chain.updateChainCoordinateFw(rig, tail, _v);
      this.applyJointConstraints(rig, chain, head, tail, false);
    }
  }

  /** 轴投影 + 角锥限制（与 Godot 一致走 bw/fw 守卫版更新；内联调用，热路径禁止闭包分配） */
  private applyJointConstraints(rig: SkeletonRig, chain: IKChain, head: number, tail: number, isBackward: boolean): void {
    const js = chain.jointSettings[head]!;
    const info = chain.solverInfos[head]!;
    if (js.rotationAxis === 'all' && !js.limitation) return;
    const anchor = isBackward ? tail : head; // 固定端
    const moving = isBackward ? head : tail; // 被移动端
    if (js.rotationAxis !== 'all') {
      _v.copy(chain.chain[moving]!).sub(chain.chain[anchor]!);
      // 输出必须用独立临时量 _v2（Godot 为值语义传参）：同参调用（_v,_v）会使
      // getProjectedRotation 在 |localNrm·axis| > ALMOST_ONE 时的回退分支 out.copy(vector)
      // 退化为自赋值、回退失效（此时输入已被就地改写）。见 ccd-ik.ts 同款注释。
      js.getProjectedRotation(info.currentGrest, _v, _v2);
      if (isBackward) chain.updateChainCoordinateBw(rig, moving, _v2.add(chain.chain[anchor]!));
      else chain.updateChainCoordinateFw(rig, moving, _v2.add(chain.chain[anchor]!));
    }
    if (js.limitation) {
      _v.copy(chain.chain[moving]!).sub(chain.chain[anchor]!);
      // getLimitedRotation 同参调用安全（四元数保长 + 零长早退与原输入数值等价），保持同参。
      js.getLimitedRotation(info.currentGrest, _v, info.forwardVector, _v);
      if (isBackward) chain.updateChainCoordinateBw(rig, moving, _v.add(chain.chain[anchor]!));
      else chain.updateChainCoordinateFw(rig, moving, _v.add(chain.chain[anchor]!));
    }
  }
}
