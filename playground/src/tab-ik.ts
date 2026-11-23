import type GUI from 'lil-gui';
import { Object3D, Quaternion, Vector3, type Camera } from 'three';
import {
  createSkeletonControls,
  type BoneControlHandle,
  type ChainControlHandle,
  type DragTarget,
  type LimbControlHandle,
  type LookAtControlHandle,
  type PoleOrbit,
  type RootControlHandle,
  type RotateRings,
} from '@dreamerbird/threeik/controls';
import type { LoadedCharacter } from './character';

export function createLegacyPoseEngine({ rig, facing }: LoadedCharacter, camera: Camera, gui: GUI) {
  const bone = (name: string) => rig.getBoneAt(rig.boneIndex(`mixamorig${name}`));
  const poleHint = (root: string, middle: string, end: string, fallback: number) => {
    const origin = bone(root).getWorldPosition(new Vector3());
    const joint = bone(middle).getWorldPosition(new Vector3());
    const axis = bone(end).getWorldPosition(new Vector3()).sub(origin).normalize();
    const offset = joint.clone().sub(origin);
    return offset.addScaledVector(axis, -offset.dot(axis)).lengthSq() > 1e-8
      ? joint
      : joint.addScaledVector(facing, fallback);
  };
  const controls = createSkeletonControls({
    rig, camera, facing,
    // The common pose editor owns rendering and input. These targets only feed the original modifiers.
    scene: new Object3D(),
    dom: document.createElement('div'),
    manipulator: { attachedTo: null, setMode() {}, attach() {}, dispose() {} },
    hotkeys: false,
    controls: [
      { kind: 'root', name: 'hips', bone: 'mixamorigHips', rotation: true },
      ...(['Left', 'Right'] as const).map(side => ({
        kind: 'limb' as const, name: `leg${side[0]}`,
        rootBone: `mixamorig${side}UpLeg`, middleBone: `mixamorig${side}Leg`, endBone: `mixamorig${side}Foot`,
        carry: false, endRotation: true, rootRotation: true,
        pole: { position: poleHint(`${side}UpLeg`, `${side}Leg`, `${side}Foot`, 0.2) },
      })),
      { kind: 'chain', name: 'spine', rootBone: 'mixamorigSpine', endBone: 'mixamorigNeck' },
      { kind: 'bone', name: 'chest', bone: 'mixamorigSpine2' },
      { kind: 'bone', name: 'neck', bone: 'mixamorigNeck' },
      { kind: 'bone', name: 'clavicleL', bone: 'mixamorigLeftShoulder' },
      { kind: 'bone', name: 'clavicleR', bone: 'mixamorigRightShoulder' },
      { kind: 'bone', name: 'toeL', bone: 'mixamorigLeftToeBase' },
      { kind: 'bone', name: 'toeR', bone: 'mixamorigRightToeBase' },
      ...(['Left', 'Right'] as const).map(side => ({
        kind: 'limb' as const, name: `arm${side[0]}`,
        rootBone: `mixamorig${side}Arm`, middleBone: `mixamorig${side}ForeArm`, endBone: `mixamorig${side}Hand`,
        endRotation: true, rootRotation: true,
        pole: { position: poleHint(`${side}Arm`, `${side}ForeArm`, `${side}Hand`, -0.2) },
      })),
      { kind: 'lookAt', name: 'head', rootBone: 'mixamorigNeck', endBone: 'mixamorigHead', rotateShare: 0.4 },
    ],
  });
  const hips = controls.get<RootControlHandle>('hips')!;
  const spine = controls.get<ChainControlHandle>('spine')!;
  const head = controls.get<LookAtControlHandle>('head')!;
  const chest = controls.get<BoneControlHandle>('chest')!;
  const neck = controls.get<BoneControlHandle>('neck')!;

  const targets = new Map<string, { target: DragTarget; joint: Object3D }>([
    ['hips', { target: hips.target, joint: bone('Hips') }],
    ['neck', { target: spine.target, joint: bone('Neck') }],
  ]);
  const rotations = new Map<string, RotateRings>([
    ['hips', hips.rings!], ['chest', chest.rings], ['head', head.rings!],
  ]);
  const ringJoints = new Map<RotateRings, Object3D>([
    [hips.rings!, bone('Hips')], [chest.rings, bone('Spine2')], [neck.rings, bone('Neck')],
  ]);
  const landmarkRings = new Map<string, RotateRings>([['hips:front', hips.rings!], ['chest:front', chest.rings]]);
  const middleControls = new Map<string, { limb: LimbControlHandle; bone: Object3D }>();
  const translatedControls = new Map<string, DragTarget>([['spine', spine.target], ['chest', spine.target]]);
  const modifiers = gui.addFolder('原始 IK 参数');
  const limbs: LimbControlHandle[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const suffix = side[0];
    const arm = controls.get<LimbControlHandle>(`arm${suffix}`)!;
    const leg = controls.get<LimbControlHandle>(`leg${suffix}`)!;
    const clavicle = controls.get<BoneControlHandle>(`clavicle${suffix}`)!;
    const toe = controls.get<BoneControlHandle>(`toe${suffix}`)!;
    limbs.push(arm, leg);
    for (const [limb, end, middle, direction] of [
      [arm, 'Hand', 'ForeArm', 'elbow-direction'],
      [leg, 'Foot', 'Leg', 'knee-direction'],
    ] as const) {
      const name = limb.name;
      const endBone = bone(side + end);
      targets.set(name, { target: limb.target, joint: endBone });
      rotations.set(name, limb.rings!);
      ringJoints.set(limb.rings!, endBone);
      rotations.set(`${name}:root`, limb.shoulderRings!);
      rotations.set(`${name}:elbow`, limb.elbowRings);
      middleControls.set(`${name}:elbow`, { limb, bone: bone(side + middle) });
      middleControls.set(`${name}:${direction}`, { limb, bone: bone(side + middle) });
      landmarkRings.set(`${name}:side`, limb.rings!);
    }
    rotations.set(`${arm.name}:clavicle`, clavicle.rings);
    ringJoints.set(clavicle.rings, bone(`${side}Shoulder`));
    ringJoints.set(toe.rings, bone(`${side}ToeBase`));
    landmarkRings.set(`${arm.name}:root`, clavicle.rings);
    landmarkRings.set(`${arm.name}:palm`, arm.rings!);
    landmarkRings.set(`${leg.name}:heel`, leg.rings!);
    landmarkRings.set(`${leg.name}:toe`, toe.rings);
    translatedControls.set(`${arm.name}:clavicle`, spine.target);
    translatedControls.set(`${leg.name}:root`, hips.target);
  }

  for (const [name, mod] of [
    ['骨盆 RootMotion', hips.modifier], ['FABRIK 颈根', spine.modifier], ['CCD 头部注视', head.modifier],
    ...limbs.map(limb => [`TwoBone ${limb.name}`, limb.modifier] as const),
  ] as const) {
    const folder = modifiers.addFolder(name).close();
    folder.add(mod, 'active').name('启用');
    folder.add(mod, 'influence', 0, 1, 0.01).name('权重');
    if ('maxIterations' in mod) {
      folder.add(mod, 'maxIterations', 1, 30, 1).name('迭代次数');
      folder.add(mod, 'angularDeltaLimit', 0, Math.PI, 0.005).name('求解角步长(rad)');
    }
  }
  modifiers.add(chest.modifier, 'active').name('胸口旋转');
  modifiers.add(neck.modifier, 'active').name('颈部旋转');
  const limits = { reachScale: 1, keepAlive: 1, hipsRadius: 0.4, headRadius: 0.35, headAngle: 105 };
  const clamp = modifiers.addFolder('钳制范围');
  clamp.add(limits, 'reachScale', 0.3, 1.5, 0.01).name('位置球半径倍率').onChange((scale: number) => {
    for (const limb of limbs) limb.setReachScale(scale);
    spine.setReachScale(scale);
  });
  clamp.add(limits, 'keepAlive', 0.85, 1, 0.005).name('四肢伸展上限').onChange((value: number) => {
    for (const limb of limbs) limb.setKeepAlive(value);
  });
  clamp.add(limits, 'hipsRadius', 0.1, 0.8, 0.01).name('骨盆活动半径(m)').onChange((value: number) => hips.setRadius(value));
  clamp.add(limits, 'headRadius', 0.3, 1, 0.05).name('注视距离(m)').onChange((value: number) => head.setRadius(value));
  clamp.add(limits, 'headAngle', 30, 170, 1).name('注视半角(°)').onChange((value: number) => head.setConeAngleDeg(value));
  modifiers.close();

  const pivot = new Vector3();
  const from = new Vector3();
  const to = new Vector3();
  const swing = new Quaternion();
  const orientation = new Quaternion();
  let draggedTarget: DragTarget | PoleOrbit | undefined;
  function endMove() {
    draggedTarget?.endExternalDrag();
    draggedTarget = undefined;
  }
  function beginMove(target: DragTarget | PoleOrbit) {
    if (draggedTarget === target) return;
    endMove();
    target.beginExternalDrag();
    draggedTarget = target;
  }
  function aimFromLandmark(joint: Object3D, effector: Object3D, desired: Vector3): boolean {
    joint.getWorldPosition(pivot);
    effector.getWorldPosition(from).sub(pivot);
    to.copy(desired).sub(pivot);
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return false;
    swing.setFromUnitVectors(from.normalize(), to.normalize());
    return true;
  }

  return {
    controls,
    rotationFor: (id?: string) => id ? rotations.get(id) : undefined,
    move(id: string, effector: Object3D, marker: DragTarget, previous: Vector3) {
      const desired = marker.position;
      const direct = targets.get(id);
      if (direct) {
        if (marker.isDragging) beginMove(direct.target);
        direct.target.moveTo(desired);
        return;
      }
      const middle = middleControls.get(id);
      if (middle) {
        const { pole } = middle.limb;
        if (id.endsWith('-direction')) {
          pole.setDirection(to.copy(desired).sub(middle.bone.getWorldPosition(pivot)));
        } else {
          beginMove(pole);
          pole.ball.position.copy(pole.worldToLocal(to.copy(desired)));
          pole.reclamp();
          if (!marker.isDragging) endMove();
        }
        return;
      }
      const translated = translatedControls.get(id);
      if (translated) {
        if (marker.isDragging) beginMove(translated);
        translated.getWorldPosition(to).add(desired).sub(previous);
        translated.moveTo(to);
        return;
      }
      if (id === 'head:front') {
        if (marker.isDragging) beginMove(head.target);
        head.target.moveTo(desired);
        return;
      }
      if (id === 'head') {
        if (aimFromLandmark(bone('Head'), effector, desired)) {
          if (marker.isDragging) beginMove(head.target);
          head.target.getWorldPosition(to).sub(pivot).applyQuaternion(swing).add(pivot);
          head.target.moveTo(to);
        }
        return;
      }
      const rings = landmarkRings.get(id);
      if (rings) {
        const joint = ringJoints.get(rings)!;
        if (!aimFromLandmark(joint, effector, desired)) return;
        rings.beginExternalDrag(-1);
        rings.quaternion.copy(swing.multiply(joint.getWorldQuaternion(orientation)));
        rings.updateExternalDrag();
        rings.endExternalDrag();
      }
    },
    endMove,
    update() {
      rig.update(1 / 60);
      controls.update();
    },
    reset() {
      endMove();
      for (const { target, joint } of targets.values()) target.moveTo(joint.getWorldPosition(to));
      for (const [rings, joint] of ringJoints) rings.setOrientationCarry(joint.parent!);
      for (const { limb, bone: joint } of middleControls.values()) {
        limb.rollModifier.setAngle(0, 0);
        limb.pole.setDirectionHint(joint.getWorldPosition(to));
      }
      head.target.moveTo(bone('Head').getWorldPosition(to).addScaledVector(facing, limits.headRadius));
      controls.update();
    },
  };
}
