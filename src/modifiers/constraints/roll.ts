import { Quaternion, Vector3 } from 'three';
import type { SkeletonRig } from '../../core/skeleton-rig';
import { Modifier } from '../modifier';

export interface RollConfig {
  amount?: number;
  /** 滚转施加骨（如前臂/小腿） */
  applyBone: string;
  /** 纵轴参照：滚转轴 = applyBone 局部系中指向该子骨的方向（如前臂→手）。子骨局部位置是
   *  姿势不变量（modifier 不改局部位置），故轴恒定；滚转时子骨位置不动、朝向跟随 */
  childBone: string;
  /** 滚转角（弧度，绕纵轴，右手系） */
  angle?: number;
}

const _axis = new Vector3();
const _q = new Quaternion();
const _roll = new Quaternion();

/**
 * 单骨滚转（扭转）：对 applyBone 的局部旋转右乘一个「绕自身纵轴」的附加滚转——
 * 世界效果 = 骨骼绕「指向 childBone 的轴」原地滚 angle（手/脚位置不动，只有朝向滚）。
 * 用途：肘/膝操纵器的扭转通道——TwoBone 求解把中骨朝向整体重写，附加滚转必须在求解
 * 之后重新施加（排序锚骨取中骨：TwoBone(根) 之后、端骨定向(端) 之前），角度由控制层持久持有。
 */
export class RollModifier extends Modifier {
  constructor(private configs: RollConfig[]) {
    super();
  }

  /** 控制层写通道角（弧度） */
  setAngle(index: number, angle: number): void {
    this.configs[index]!.angle = angle;
  }

  processModification(rig: SkeletonRig, _delta: number): void {
    for (const c of this.configs) {
      const angle = (c.angle ?? 0) * (c.amount ?? 1);
      if (Math.abs(angle) < 1e-12) continue;
      const bone = rig.boneIndex(c.applyBone);
      const child = rig.findBoneIndex(c.childBone);
      if (child < 0) {
        rig.warnOnce(`roll-child-missing:${c.childBone}`, `RollModifier: childBone not found: ${c.childBone}`);
        continue;
      }
      rig.getPosePosition(child, _axis); // 子骨局部位置 = 纵轴（常量）
      if (_axis.lengthSq() < 1e-12) {
        rig.warnOnce(`roll-axis-degenerate:${c.applyBone}`, `RollModifier: ${c.childBone} 与 ${c.applyBone} 同点，纵轴未定义`);
        continue;
      }
      _axis.normalize();
      rig.getPoseRotation(bone, _q);
      _roll.setFromAxisAngle(_axis, angle);
      _q.multiply(_roll).normalize(); // 局部右乘 = 绕自身纵轴滚（世界系效果 = 绕世界纵轴转 angle）
      rig.setPoseRotation(bone, _q);
    }
  }

  toJSON(): Record<string, unknown> {
    return { type: 'roll', configs: this.configs.map((c) => ({ ...c })) };
  }
}
