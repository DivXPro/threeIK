import { HUMANOID_PROFILE } from './humanoid-profile';

/** profile 骨名 → 模型骨名 */
export class BoneMap {
  private profileToModel = new Map<string, string>();
  private modelToProfile = new Map<string, string>();

  set(profileName: string, modelBoneName: string): void {
    this.profileToModel.set(profileName, modelBoneName);
    this.modelToProfile.set(modelBoneName, profileName);
  }

  findModelBone(profileName: string): string | null {
    return this.profileToModel.get(profileName) ?? null;
  }

  findProfileBone(modelBoneName: string): string | null {
    return this.modelToProfile.get(modelBoneName) ?? null;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.profileToModel);
  }

  static fromJSON(json: Record<string, string>): BoneMap {
    return BoneMap.fromPreset(json);
  }

  static fromPreset(preset: Record<string, string>): BoneMap {
    const map = new BoneMap();
    for (const [profileName, modelName] of Object.entries(preset)) map.set(profileName, modelName);
    return map;
  }
}

const SIDES = ['Left', 'Right'] as const;
const FINGERS: Array<[profileFinger: string, mixamoFinger: string]> = [
  ['Thumb', 'Thumb'],
  ['Index', 'Index'],
  ['Middle', 'Middle'],
  ['Ring', 'Ring'],
  ['Little', 'Pinky'],
];
const FINGER_SEGMENTS: Array<[profileSeg: string, mixamoIdx: number]> = [
  ['Proximal', 1],
  ['Intermediate', 2],
  ['Distal', 3],
];

/** Mixamo 命名（prefix 默认 'mixamorig:'；three.js Soldier.glb 用 'mixamorig' 无冒号） */
export function mixamoPreset(prefix = 'mixamorig:'): Record<string, string> {
  const p: Record<string, string> = {
    Hips: `${prefix}Hips`,
    Spine: `${prefix}Spine`,
    Chest: `${prefix}Spine1`,
    UpperChest: `${prefix}Spine2`,
    Neck: `${prefix}Neck`,
    Head: `${prefix}Head`,
  };
  for (const S of SIDES) {
    p[`${S}Shoulder`] = `${prefix}${S}Shoulder`;
    p[`${S}UpperArm`] = `${prefix}${S}Arm`;
    p[`${S}LowerArm`] = `${prefix}${S}ForeArm`;
    p[`${S}Hand`] = `${prefix}${S}Hand`;
    p[`${S}UpperLeg`] = `${prefix}${S}UpLeg`;
    p[`${S}LowerLeg`] = `${prefix}${S}Leg`;
    p[`${S}Foot`] = `${prefix}${S}Foot`;
    p[`${S}Toes`] = `${prefix}${S}ToeBase`;
    for (const [profileFinger, mixamoFinger] of FINGERS) {
      if (profileFinger === 'Thumb') {
        p[`${S}ThumbMetacarpal`] = `${prefix}${S}HandThumb1`;
        p[`${S}ThumbProximal`] = `${prefix}${S}HandThumb2`;
        p[`${S}ThumbDistal`] = `${prefix}${S}HandThumb3`;
      } else {
        for (const [seg, idx] of FINGER_SEGMENTS) {
          p[`${S}${profileFinger}${seg}`] = `${prefix}${S}Hand${mixamoFinger}${idx}`;
        }
      }
    }
  }
  return p;
}

/** ReadyPlayerMe：无前缀 Mixamo 命名 */
export function readyPlayerMePreset(): Record<string, string> {
  return mixamoPreset('');
}

/** VRM 1.0：camelCase 人形骨名 */
export function vrmPreset(): Record<string, string> {
  const p: Record<string, string> = {};
  for (const bone of HUMANOID_PROFILE) {
    if (bone.name === 'Root') continue;
    p[bone.name] = bone.name.charAt(0).toLowerCase() + bone.name.slice(1);
  }
  return p;
}

/** 骨名与 profile 完全一致（程序化骨架/已按 profile 重命名） */
export function identityPreset(): Record<string, string> {
  const p: Record<string, string> = {};
  for (const bone of HUMANOID_PROFILE) p[bone.name] = bone.name;
  return p;
}

const MIXAMO_PREFIXES = ['mixamorig:', 'mixamorig_', 'mixamorig', ''];

/** 尝试各预设与 Mixamo 前缀变体，返回 required 骨覆盖率最高的映射 */
export function suggestBoneMap(boneNames: string[]): { map: BoneMap; coverage: number; presetName: string } {
  const available = new Set(boneNames);
  const candidates: Array<{ name: string; preset: Record<string, string> }> = [
    ...MIXAMO_PREFIXES.map((prefix) => ({ name: `mixamo(${prefix || '无前缀'})`, preset: mixamoPreset(prefix) })),
    { name: 'vrm', preset: vrmPreset() },
    { name: 'identity', preset: identityPreset() },
  ];
  let best = { map: new BoneMap(), coverage: 0, presetName: 'none' };
  for (const { name, preset } of candidates) {
    const map = BoneMap.fromPreset(preset);
    const required = HUMANOID_PROFILE.filter((b) => b.required);
    const hits = required.filter((b) => {
      const modelName = preset[b.name];
      return modelName !== undefined && available.has(modelName);
    }).length;
    const coverage = hits / required.length;
    if (coverage > best.coverage) best = { map, coverage, presetName: name };
    if (coverage === 1) break;
  }
  return best;
}
