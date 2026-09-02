import { Bone, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { ThreeIKError } from './errors';
import { TinyEmitter } from './events';
import type { Modifier } from '../modifiers/modifier';

type RigEvent = 'rest-updated' | 'warning';

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();

export class SkeletonRig {
  private bones: Bone[] = [];
  private parent: Int32Array = new Int32Array(0);
  private span: Uint32Array = new Uint32Array(0);
  private nameToIndex = new Map<string, number>();

  // 分解存储：rest / base / work 三套局部姿势 + 全局姿势缓存（忽略 scale）
  private restPos!: Float32Array;
  private restQuat!: Float32Array;
  private restScale!: Float32Array;
  private basePos!: Float32Array;
  private baseQuat!: Float32Array;
  private baseScale!: Float32Array;
  private workPos!: Float32Array;
  private workQuat!: Float32Array;
  private workScale!: Float32Array;
  private globalPos!: Float32Array;
  private globalQuat!: Float32Array;
  private globalRestPos!: Float32Array;
  private globalRestQuat!: Float32Array;
  private globalDirty!: Uint8Array;
  private globalDirtyAny = false;

  private modifiers: Modifier[] = [];
  private prevPosePos!: Float32Array;
  private prevPoseQuat!: Float32Array;
  private prevPoseScale!: Float32Array;

  /** 重定向位移缩放（Godot motion_scale），默认 1；可用 computeMotionScaleFromBone 设置 */
  motionScale = 1;

  /** 字符串 target 的解析器（theatre 接入层注入）：key → Object3D */
  targetResolver?: (key: string) => Object3D | null | undefined;

  private emitter = new TinyEmitter<RigEvent>();

  constructor(root: Object3D) {
    this.rebind(root);
  }

  get boneCount(): number {
    return this.bones.length;
  }

  get boneNames(): readonly string[] {
    return this.bones.map((b) => b.name);
  }

  boneIndex(name: string): number {
    const idx = this.nameToIndex.get(name);
    if (idx === undefined) throw ThreeIKError.boneNotFound(name);
    return idx;
  }

  findBoneIndex(name: string): number {
    return this.nameToIndex.get(name) ?? -1;
  }

  getBoneName(i: number): string {
    return this.bones[i]!.name;
  }

  getParentIndex(i: number): number {
    return this.parent[i]!;
  }

  getBoneAt(i: number): Bone {
    return this.bones[i]!;
  }

  /** theatre 快照编辑器 clone 场景后调用：在新 Bone 树上重建全部缓存 */
  rebind(root: Object3D): void {
    const bones: Bone[] = [];
    const parentIdx: number[] = [];
    // DFS 前序遍历：非 Bone 节点不入列但展开其子节点；Bone 的父索引 = 最近的 Bone 祖先
    const visit = (obj: Object3D, parentBoneIdx: number): void => {
      let idx = parentBoneIdx;
      if ((obj as Bone).isBone) {
        idx = bones.length;
        bones.push(obj as Bone);
        parentIdx.push(parentBoneIdx);
      }
      for (const child of obj.children) visit(child, idx);
    };
    visit(root, -1);
    if (bones.length === 0) {
      throw ThreeIKError.configError('SkeletonRig: no Bone found under the given root');
    }

    this.bones = bones;
    const n = bones.length;
    this.parent = Int32Array.from(parentIdx);
    this.nameToIndex = new Map(bones.map((b, i) => [b.name, i]));

    // nested-set 区间：DFS 序下子树连续，span[i] = 子树大小
    this.span = new Uint32Array(n).fill(1);
    for (let i = n - 1; i > 0; i--) {
      this.span[this.parent[i]!]! += this.span[i]!;
    }

    const alloc = (stride: number) => new Float32Array(n * stride);
    this.restPos = alloc(3); this.restQuat = alloc(4); this.restScale = alloc(3);
    this.basePos = alloc(3); this.baseQuat = alloc(4); this.baseScale = alloc(3);
    this.workPos = alloc(3); this.workQuat = alloc(4); this.workScale = alloc(3);
    this.globalPos = alloc(3); this.globalQuat = alloc(4);
    this.globalRestPos = alloc(3); this.globalRestQuat = alloc(4);
    this.globalDirty = new Uint8Array(n);
    this.prevPosePos = alloc(3); this.prevPoseQuat = alloc(4); this.prevPoseScale = alloc(3);

    // 构造时的骨骼 TRS = rest pose；base/work 初始化为 rest
    for (let i = 0; i < n; i++) {
      bones[i]!.position.toArray(this.restPos, i * 3);
      bones[i]!.quaternion.toArray(this.restQuat, i * 4);
      bones[i]!.scale.toArray(this.restScale, i * 3);
    }
    this.recomputeGlobalRest();
    this.resetToRest();

    // 拓扑可能已变更（增删骨/改层级/重命名）：重建全部 modifier 的索引与链缓存。
    // 先统一 detach 再统一 attach（RetargetModifier 的 rest-updated 订阅成对退订/重订），
    // 重建期间 modifier 不持有半新半旧的 rig 状态
    for (const m of this.modifiers) m.detach();
    for (const m of this.modifiers) m.attach(this);
  }

  // ---- rest ----

  getRestPosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.restPos, i * 3);
  }

  getRestQuaternion(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.restQuat, i * 4);
  }

  getRestScale(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.restScale, i * 3);
  }

  setRestPose(i: number, partial: { position?: Vector3; quaternion?: Quaternion; scale?: Vector3 }): void {
    if (partial.position) partial.position.toArray(this.restPos, i * 3);
    if (partial.quaternion) partial.quaternion.toArray(this.restQuat, i * 4);
    if (partial.scale) partial.scale.toArray(this.restScale, i * 3);
    this.recomputeGlobalRest();
    this.emitter.emit('rest-updated');
  }

  getGlobalRestPosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.globalRestPos, i * 3);
  }

  getGlobalRestQuaternion(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.globalRestQuat, i * 4);
  }

  private recomputeGlobalRest(): void {
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      const p = this.parent[i]!;
      _v.fromArray(this.restPos, i * 3);
      _q.fromArray(this.restQuat, i * 4);
      if (p < 0) {
        _v.toArray(this.globalRestPos, i * 3);
        _q.normalize().toArray(this.globalRestQuat, i * 4);
      } else {
        _q2.fromArray(this.globalRestQuat, p * 4);
        _v.applyQuaternion(_q2).add(_v2.fromArray(this.globalRestPos, p * 3));
        _v.toArray(this.globalRestPos, i * 3);
        _q2.multiply(_q).normalize().toArray(this.globalRestQuat, i * 4);
      }
    }
  }

  // ---- base pose ----

  /** 动画路径：在 AnimationMixer.update 之后、update 之前调用，把骨骼当前 TRS 采为基准姿势 */
  captureBasePose(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i]!;
      b.position.toArray(this.basePos, i * 3);
      b.quaternion.toArray(this.baseQuat, i * 4);
      b.scale.toArray(this.baseScale, i * 3);
    }
  }

  /** FK 编辑路径：同时写 base 缓冲与 Bone（不经过 modifier） */
  setBasePoseRotation(i: number, q: Quaternion): void {
    q.toArray(this.baseQuat, i * 4);
    this.bones[i]!.quaternion.copy(q);
  }

  setBasePosePosition(i: number, v: Vector3): void {
    v.toArray(this.basePos, i * 3);
    this.bones[i]!.position.copy(v);
  }

  getBasePoseRotation(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.baseQuat, i * 4);
  }

  getBasePosePosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.basePos, i * 3);
  }

  resetToRest(): void {
    this.basePos.set(this.restPos);
    this.baseQuat.set(this.restQuat);
    this.baseScale.set(this.restScale);
    this.workPos.set(this.restPos);
    this.workQuat.set(this.restQuat);
    this.workScale.set(this.restScale);
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i]!;
      b.position.fromArray(this.restPos, i * 3);
      b.quaternion.fromArray(this.restQuat, i * 4);
      b.scale.fromArray(this.restScale, i * 3);
    }
    this.globalDirty.fill(1);
    this.globalDirtyAny = true;
  }

  // ---- working pose（modifier 写入面）----

  /** modifier 写局部旋转；子树全局姿势标脏（Godot set_bone_pose_rotation） */
  setPoseRotation(i: number, q: Quaternion): void {
    q.toArray(this.workQuat, i * 4);
    this.markGlobalDirtySubtree(i);
  }

  setPosePosition(i: number, v: Vector3): void {
    v.toArray(this.workPos, i * 3);
    this.markGlobalDirtySubtree(i);
  }

  getPoseRotation(i: number, out: Quaternion): Quaternion {
    return out.fromArray(this.workQuat, i * 4);
  }

  getPosePosition(i: number, out: Vector3): Vector3 {
    return out.fromArray(this.workPos, i * 3);
  }

  // ---- global pose ----

  getGlobalPosePosition(i: number, out: Vector3): Vector3 {
    if (this.globalDirtyAny) this.updateGlobalPose();
    return out.fromArray(this.globalPos, i * 3);
  }

  getGlobalPoseQuaternion(i: number, out: Quaternion): Quaternion {
    if (this.globalDirtyAny) this.updateGlobalPose();
    return out.fromArray(this.globalQuat, i * 4);
  }

  /** DFS 单遍前向扫描，只重算脏段（父索引恒小于子索引，父必先算完） */
  updateGlobalPose(): void {
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      if (!this.globalDirty[i]) continue;
      const p = this.parent[i]!;
      _v.fromArray(this.workPos, i * 3);
      _q.fromArray(this.workQuat, i * 4);
      if (p < 0) {
        _v.toArray(this.globalPos, i * 3);
        _q.normalize().toArray(this.globalQuat, i * 4);
      } else {
        const gq = _q2.fromArray(this.globalQuat, p * 4);
        _v.applyQuaternion(gq).add(_v2.fromArray(this.globalPos, p * 3));
        _v.toArray(this.globalPos, i * 3);
        _q2.multiply(_q).normalize().toArray(this.globalQuat, i * 4);
      }
      this.globalDirty[i] = 0;
    }
    this.globalDirtyAny = false;
  }

  getSubtreeSpan(i: number): number {
    return this.span[i]!;
  }

  private markGlobalDirtySubtree(i: number): void {
    this.globalDirty.fill(1, i, i + this.span[i]!);
    this.globalDirtyAny = true;
  }

  // ---- rig space ----

  /** 世界坐标 → rig 空间（root bone 父对象的局部空间；全局姿势合成所在空间） */
  worldToRigSpace(worldPos: Vector3, out: Vector3): Vector3 {
    const parentObj = this.bones[0]!.parent;
    if (!parentObj) return out.copy(worldPos);
    parentObj.updateWorldMatrix(true, false);
    return out.copy(worldPos).applyMatrix4(_m.copy(parentObj.matrixWorld).invert());
  }

  computeMotionScaleFromBone(name: string): number {
    const i = this.boneIndex(name);
    this.getGlobalRestPosition(i, _v);
    return _v.length();
  }

  // ---- events ----

  on(event: RigEvent, cb: (payload?: unknown) => void): () => void {
    return this.emitter.on(event, cb);
  }

  off(event: RigEvent, cb: (payload?: unknown) => void): void {
    this.emitter.off(event, cb);
  }

  warnOnce(key: string, message: string): void {
    this.emitter.warnOnce(key, message);
  }

  // ---- modifier chain ----

  addModifier(m: Modifier): void {
    // 同一实例重复添加：忽略（否则重复 attach，RetargetModifier 会泄漏一份 rest-updated 订阅）
    if (this.modifiers.includes(m)) return;
    this.modifiers.push(m);
    m.attach(this);
  }

  removeModifier(m: Modifier): void {
    const idx = this.modifiers.indexOf(m);
    if (idx >= 0) {
      this.modifiers.splice(idx, 1);
      m.detach();
    }
  }

  getModifiers(): readonly Modifier[] {
    return this.modifiers;
  }

  // ---- update（Task 7 加入 modifier 管线）----

  update(delta: number): void {
    this.seedWorkFromBase();
    this.markGlobalDirtySubtree(0); // work 整体重置，全局姿势全量失效
    for (const m of this.modifiers) {
      if (!m.active || m.influence <= 0) continue;
      if (m.influence >= 1) {
        m.processModification(this, delta);
        continue;
      }
      // influence 混合：快照 → 执行 → slerp/lerp（Godot 在 modifier 外做插值）
      this.prevPosePos.set(this.workPos);
      this.prevPoseQuat.set(this.workQuat);
      this.prevPoseScale.set(this.workScale);
      m.processModification(this, delta);
      this.blendWorkPose(m.influence);
    }
    this.writeBackToBones();
  }

  /** work = prev + (work - prev) * w（逐骨 pos lerp / quat slerp / scale lerp） */
  private blendWorkPose(w: number): void {
    for (let i = 0; i < this.bones.length; i++) {
      _v.fromArray(this.prevPosePos, i * 3).lerp(_v2.fromArray(this.workPos, i * 3), w);
      _v.toArray(this.workPos, i * 3);
      _q.fromArray(this.prevPoseQuat, i * 4).slerp(_q2.fromArray(this.workQuat, i * 4), w);
      _q.toArray(this.workQuat, i * 4);
      _v.fromArray(this.prevPoseScale, i * 3).lerp(_v2.fromArray(this.workScale, i * 3), w);
      _v.toArray(this.workScale, i * 3);
    }
    if (this.bones.length > 0) this.markGlobalDirtySubtree(0);
  }

  protected seedWorkFromBase(): void {
    this.workPos.set(this.basePos);
    this.workQuat.set(this.baseQuat);
    this.workScale.set(this.baseScale);
  }

  protected writeBackToBones(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i]!;
      b.position.fromArray(this.workPos, i * 3);
      // float32 缓冲读回的四元数模长略偏离 1（最坏 ~1e-8），写回前归一化，
      // 与 updateGlobalPose/recomputeGlobalRest 的 normalize 约定一致；
      // 否则骨骼矩阵会带上微小缩放，且 angleTo 比较会被 acos 在 dot≈1 处放大
      b.quaternion.fromArray(this.workQuat, i * 4).normalize();
      b.scale.fromArray(this.workScale, i * 3);
    }
  }

  // ---- 序列化（骨架编辑数据层）----

  /** rest 数据快照：{ bones: [{name, parent, position, quaternion, scale}] } */
  toJSON(): { bones: Array<{ name: string; parent: string | null; position: number[]; quaternion: number[]; scale: number[] }> } {
    return {
      bones: this.bones.map((b, i) => ({
        name: b.name,
        parent: this.parent[i]! >= 0 ? this.bones[this.parent[i]!]!.name : null,
        position: Array.from(this.restPos.slice(i * 3, i * 3 + 3)),
        quaternion: Array.from(this.restQuat.slice(i * 4, i * 4 + 4)),
        scale: Array.from(this.restScale.slice(i * 3, i * 3 + 3)),
      })),
    };
  }
}
