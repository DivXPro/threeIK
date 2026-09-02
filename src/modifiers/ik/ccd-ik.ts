import { Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { isZeroApprox } from '../../core/math';
import type { IKChain } from './ik-chain';
import { IterateIKModifier } from './iterate-ik';

const _q = new Quaternion();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3(); // 专用：getProjectedRotation 的输出（见下方调用处注释）

export class CCDIkModifier extends IterateIKModifier {
  protected solveIteration(rig: SkeletonRig, chain: IKChain, destination: Vector3): void {
    const jointSize = chain.joints.length;

    // 外层：ancestor 倒序；内层：正序（Godot 双层循环）
    for (let ancestor = jointSize - 1; ancestor >= 0; ancestor--) {
      for (let i = ancestor; i < jointSize; i++) {
        const info = chain.solverInfos[i];
        if (!info || isZeroApprox(info.length)) continue;

        const head = i;
        const tail = i + 1;

        const headPos = _v1.copy(chain.chain[head]!);
        const headToEffector = _v2.copy(chain.getChainEnd()).sub(headPos);
        const headToDest = _v3.copy(destination).sub(headPos);
        if (isZeroApprox(headToDest.lengthSq() * headToEffector.lengthSq())) continue;

        // toRot = from-to 旋转；新 tail = head + toRot * (tail - head)
        const toRot = _q.setFromUnitVectors(headToEffector.normalize(), headToDest.normalize());
        _v2.copy(chain.chain[tail]!).sub(headPos).applyQuaternion(toRot).add(headPos);
        chain.updateChainCoordinateFw(rig, tail, _v2);

        const js = chain.jointSettings[head]!;
        if (js.rotationAxis !== 'all') {
          // 轴投影：tail = head + getProjectedRotation(grest, tail - head)
          _v2.copy(chain.chain[tail]!).sub(chain.chain[head]!);
          // 输出必须用独立临时量 _v4（Godot 为值语义传参）：getProjectedRotation 在
          // |localNrm·axis| > ALMOST_ONE 时回退为返回原输入向量（iterate_ik_3d.h 116–133），
          // 同参调用（_v2,_v2）会让 out.copy(vector) 成为自赋值、回退失效 —— 而 twist 关节
          // （rotationAxis 与骨方向平行）每帧都命中该分支，会把 tail 投影成近零向量后 normalize
          // 出垃圾方向。getLimitedRotation 无此问题（四元数保长，零长早退与原输入数值等价），
          // 保持同参调用。
          js.getProjectedRotation(info.currentGrest, _v2, _v4);
          chain.updateChainCoordinateFw(rig, tail, _v4.add(chain.chain[head]!));
        }
        if (js.limitation) {
          _v2.copy(chain.chain[tail]!).sub(chain.chain[head]!);
          js.getLimitedRotation(info.currentGrest, _v2, info.forwardVector, _v2);
          chain.updateChainCoordinateFw(rig, tail, _v2.add(chain.chain[head]!));
        }
      }
    }
  }
}
