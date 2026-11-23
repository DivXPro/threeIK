import { Vector3, type Bone } from 'three';

export type Landmark = 'pelvis-front' | 'chest-front' | 'head-top' | 'head-front'
  | `${'Left' | 'Right'}-${'elbow-side' | 'palm' | 'hand-side' | 'knee-side' | 'heel' | 'toe' | 'foot-side'}`;

export interface PoseLandmark {
  bone: Bone;
  offset: Vector3;
}

export function createPoseLandmarks(bones: ReadonlyMap<string, Bone>, facing: Vector3): Map<Landmark, PoseLandmark> {
  const landmarks = new Map<Landmark, PoseLandmark>();
  const bone = (name: string) => bones.get(`mixamorig${name}`)!;
  const position = (name: string) => bone(name).getWorldPosition(new Vector3());
  const add = (name: Landmark, anchor: string, worldPosition: Vector3) => {
    const parent = bone(anchor);
    landmarks.set(name, { bone: parent, offset: parent.worldToLocal(worldPosition) });
  };

  const torsoLength = position('Hips').distanceTo(position('Neck'));
  add('pelvis-front', 'Hips', position('Hips').addScaledVector(facing, torsoLength * 0.3));
  add('chest-front', 'Spine2', position('Spine2').addScaledVector(facing, torsoLength * 0.3));
  const crown = position('HeadTop_End');
  const headLength = position('Head').distanceTo(crown);
  add('head-top', 'Head', crown);
  add('head-front', 'Head', position('LeftEye').lerp(position('RightEye'), 0.5).addScaledVector(facing, headLength * 0.35));

  const up = new Vector3(0, 1, 0);
  for (const side of ['Left', 'Right'] as const) {
    const elbow = position(`${side}ForeArm`);
    const forearm = position(`${side}Hand`).sub(elbow);
    const elbowOffset = facing.clone().projectOnPlane(forearm).normalize().multiplyScalar(forearm.length() * 0.18);
    add(`${side}-elbow-side`, `${side}ForeArm`, elbow.add(elbowOffset));
    add(`${side}-palm`, `${side}Hand`, position(`${side}HandMiddle1`));
    add(`${side}-hand-side`, `${side}Hand`, position(`${side}HandPinky1`));
    const ankle = position(`${side}Foot`);
    const knee = position(`${side}Leg`);
    const shin = ankle.clone().sub(knee);
    const kneeOffset = facing.clone().projectOnPlane(shin).normalize().multiplyScalar(shin.length() * 0.16);
    add(`${side}-knee-side`, `${side}Leg`, knee.add(kneeOffset));
    const forefoot = position(`${side}ToeBase`);
    const toe = position(`${side}Toe_End`);
    const forward = forefoot.clone().sub(ankle).projectOnPlane(up);
    const footLength = forward.length();
    forward.normalize();
    const outward = new Vector3().crossVectors(up, forward).multiplyScalar(side === 'Left' ? 1 : -1);
    const heel = ankle.addScaledVector(forward, -0.42 * footLength);
    heel.y = forefoot.y;
    add(`${side}-heel`, `${side}Foot`, heel);
    add(`${side}-toe`, `${side}ToeBase`, toe);
    add(`${side}-foot-side`, `${side}Foot`, forefoot.addScaledVector(outward, 0.35 * footLength));
  }
  return landmarks;
}
