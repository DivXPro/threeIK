import GUI from 'lil-gui';
import { Object3D, Quaternion, Raycaster, Vector2, Vector3, type Bone } from 'three';
import { DragTarget, TransformControlsDriver, type ManipulatorMode } from '@dreamerbird/threeik/controls';
import { captureCharacterPose, loadCharacter, restoreCharacterPose, type LoadedCharacter } from './character';
import type { PlaygroundContext, TabHandle } from './main';
import { isPoseControlVisible, POSE_CONTROL_COLOR, setPoseMarkerShape, type PoseControlView } from './pose-controls';
import { createPoseLandmarks, type Landmark } from './pose-landmarks';
import { createLegacyPoseEngine } from './tab-ik';
import { solveIK, type IKConstraint } from './vendor/fullbody-pose-maker/ik';

const TORSO_BONES = new Set(['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].map(name => `mixamorig${name}`));
type ControlTier = 'primary' | 'joint' | 'detail';
type ControlChannels = 'position' | 'rotation' | 'both';

interface ControlPreset {
  id: string;
  label: string;
  bone: string;
  channels: ControlChannels;
  tier: ControlTier;
  landmark?: Landmark;
  positionEnabled?: boolean;
}

function limbPresets(side: 'Left' | 'Right'): ControlPreset[] {
  const label = side === 'Left' ? '左' : '右';
  const arm = `arm${side[0]}`;
  const leg = `leg${side[0]}`;
  return [
    { id: arm, label: `${label}腕`, bone: `${side}Hand`, channels: 'both', tier: 'primary', positionEnabled: true },
    { id: `${arm}:clavicle`, label: `${label}锁骨`, bone: `${side}Shoulder`, channels: 'both', tier: 'joint' },
    { id: `${arm}:root`, label: `${label}肩`, bone: `${side}Arm`, channels: 'both', tier: 'joint' },
    { id: `${arm}:elbow`, label: `${label}肘`, bone: `${side}ForeArm`, channels: 'both', tier: 'joint' },
    { id: `${arm}:elbow-direction`, label: `${label}肘朝向`, bone: `${side}ForeArm`, channels: 'position', tier: 'detail', landmark: `${side}-elbow-side` },
    { id: `${arm}:palm`, label: `${label}手掌`, bone: `${side}Hand`, channels: 'position', tier: 'detail', landmark: `${side}-palm` },
    { id: `${arm}:side`, label: `${label}掌外侧`, bone: `${side}Hand`, channels: 'position', tier: 'detail', landmark: `${side}-hand-side` },
    { id: leg, label: `${label}踝`, bone: `${side}Foot`, channels: 'both', tier: 'primary', positionEnabled: true },
    { id: `${leg}:root`, label: `${label}髋`, bone: `${side}UpLeg`, channels: 'both', tier: 'joint' },
    { id: `${leg}:elbow`, label: `${label}膝`, bone: `${side}Leg`, channels: 'both', tier: 'joint' },
    { id: `${leg}:knee-direction`, label: `${label}膝朝向`, bone: `${side}Leg`, channels: 'position', tier: 'detail', landmark: `${side}-knee-side` },
    { id: `${leg}:heel`, label: `${label}脚跟`, bone: `${side}Foot`, channels: 'position', tier: 'detail', landmark: `${side}-heel` },
    { id: `${leg}:toe`, label: `${label}脚尖`, bone: `${side}ToeBase`, channels: 'position', tier: 'detail', landmark: `${side}-toe` },
    { id: `${leg}:side`, label: `${label}前掌外侧`, bone: `${side}Foot`, channels: 'position', tier: 'detail', landmark: `${side}-foot-side` },
  ];
}

const DEFAULT_CONTROLS: readonly ControlPreset[] = [
  { id: 'hips', label: '骨盆', bone: 'Hips', channels: 'both', tier: 'primary' },
  { id: 'neck', label: '颈根', bone: 'Neck', channels: 'position', tier: 'primary' },
  { id: 'spine', label: '腹部', bone: 'Spine1', channels: 'position', tier: 'joint' },
  { id: 'chest', label: '胸口', bone: 'Spine2', channels: 'both', tier: 'joint' },
  { id: 'head', label: '头顶', bone: 'Head', channels: 'both', tier: 'joint', landmark: 'head-top' },
  { id: 'hips:front', label: '骨盆朝向', bone: 'Hips', channels: 'position', tier: 'detail', landmark: 'pelvis-front' },
  { id: 'chest:front', label: '胸口朝向', bone: 'Spine2', channels: 'position', tier: 'detail', landmark: 'chest-front' },
  { id: 'head:front', label: '头部朝向', bone: 'Head', channels: 'position', tier: 'detail', landmark: 'head-front' },
  ...limbPresets('Left'), ...limbPresets('Right'),
];

const MARKER_RADII: Record<ControlTier, number> = { primary: 0.029, joint: 0.017, detail: 0.011 };

interface ControlSettings {
  id?: string;
  label: string;
  boneName: string;
  positionEnabled: boolean;
  rotationEnabled: boolean;
  channels?: ControlChannels;
  tier?: ControlTier;
  landmark?: Landmark;
}

interface ControlPoint extends ControlSettings {
  target: DragTarget;
  previousPosition: Vector3;
  folder: GUI;
  endSite?: Object3D;
}

function boneLabel(name: string): string {
  return name.replace(/^mixamorig:?/i, '');
}

function defaultControl(boneName: string): ControlSettings {
  return { label: boneLabel(boneName), boneName, positionEnabled: true, rotationEnabled: false };
}

export function createPoseIkTab(ctx: PlaygroundContext, view: PoseControlView, engine: 'fullbody' | 'legacy'): TabHandle {
  let version = 0;
  let character: LoadedCharacter | null = null;
  let dispose: (() => void) | undefined;
  const stabilitySettings = { torsoStability: 40, lockTorso: false };
  let savedControls: ControlSettings[] = DEFAULT_CONTROLS.map(preset => ({
    id: preset.id,
    label: preset.label,
    boneName: `mixamorig${preset.bone}`,
    channels: preset.channels,
    tier: preset.tier,
    landmark: preset.landmark,
    positionEnabled: preset.positionEnabled ?? false,
    rotationEnabled: false,
  }));

  return {
    async mount(pose) {
      const mountVersion = ++version;
      const loaded = await loadCharacter(ctx.scene);
      if (mountVersion !== version) {
        loaded.root.removeFromParent();
        loaded.helper.removeFromParent();
        return;
      }
      character = loaded;
      const { rig, root } = loaded;
      const hips = rig.getBoneAt(0);
      const bones = new Map<string, Bone>();
      for (let i = 0; i < rig.boneCount; i++) {
        const bone = rig.getBoneAt(i);
        bones.set(bone.name, bone);
      }
      const landmarks = createPoseLandmarks(bones, loaded.facing);
      if (pose) restoreCharacterPose(loaded, pose);
      const boneOptions = Object.fromEntries([...bones.keys()].map(name => [boneLabel(name), name]));
      const lockedTorsoBones = new Set([...bones.values()].filter(bone => TORSO_BONES.has(bone.name)));
      const torsoAnchors = [hips, bones.get('mixamorigSpine2')!].map(effector => ({
        effector, root: hips, target: new Vector3(), targetRot: new Quaternion(),
      }));
      let editingTorso = false;
      let activeTorsoEdit: ControlPoint | null = null;
      const captureTorso = () => {
        for (const anchor of torsoAnchors) {
          anchor.effector.getWorldPosition(anchor.target);
          anchor.effector.getWorldQuaternion(anchor.targetRot);
        }
      };
      const recordEdit = (point: ControlPoint) => {
        const isTorso = TORSO_BONES.has(point.boneName);
        if (editingTorso && !isTorso) captureTorso();
        editingTorso = isTorso;
        activeTorsoEdit = isTorso ? point : null;
      };
      captureTorso();

      const gui = new GUI({ title: engine === 'legacy' ? '原始 IK' : 'Fullbody IK' });
      const legacy = engine === 'legacy' ? createLegacyPoseEngine(loaded, ctx.camera, gui) : undefined;
      const points = new Set<ControlPoint>();
      let selected: ControlPoint | null = null;
      const options = { mode: 'move' as ManipulatorMode, showGizmos: true, bone: 'mixamorigLeftForeArm' };
      const dom = ctx.renderer.domElement;
      const driver = new TransformControlsDriver(ctx.camera, ctx.scene, dom, ctx.dragControl);
      let attachedMode: ManipulatorMode | undefined;
      let draggedRing: ReturnType<NonNullable<typeof legacy>['rotationFor']>;
      const delta = new Vector3();
      const cameraRotation = new Quaternion();
      const raycaster = new Raycaster();
      const cursor = new Vector2();
      let blankPress: { x: number; y: number } | null = null;

      const controlMode = (point: ControlPoint | null): ManipulatorMode => {
        if (point?.channels === 'rotation') return 'rotate';
        if (point?.channels === 'position') return 'move';
        return options.mode;
      };

      const refreshGizmos = () => {
        const active = options.showGizmos ? selected?.target ?? null : null;
        const mode = controlMode(selected);
        if (driver.attachedTo !== active || attachedMode !== mode) {
          endGizmoDrag();
          const rings = mode === 'rotate' ? legacy?.rotationFor(selected?.id) : undefined;
          driver.attach(active, { size: 0.7, axes: rings?.axisMask, viewRing: rings?.viewRing });
          attachedMode = mode;
        }
        driver.setMode(mode);
        if (!legacy) driver.controls.setSpace('world');
        for (const point of points) {
          const { target } = point;
          const visible = point.tier !== 'detail' || isPoseControlVisible(view, point.id, selected?.id);
          target.setVisible(options.showGizmos && visible);
          target.setMarkerMode(controlMode(point) === 'rotate');
          target.setExternalManipulator(target === active);
          target.setSelected(target === active);
        }
      };
      const selectPoint = (point: ControlPoint | null) => {
        blankPress = null;
        if (point !== selected) selected?.folder.close();
        selected = point;
        selected?.folder.open();
        refreshGizmos();
      };
      function endGizmoDrag() {
        if (driver.attachedTo instanceof DragTarget) driver.attachedTo.endExternalDrag();
        legacy?.endMove();
        if (draggedRing) {
          // Legacy head rotation repositions its gaze target from the last solved pose.
          legacy?.update();
          draggedRing.endExternalDrag();
          draggedRing = undefined;
        }
      }
      driver.onDragStart = ({ axis }) => {
        blankPress = null;
        selected?.target.beginExternalDrag();
        if (controlMode(selected) === 'rotate') {
          draggedRing = legacy?.rotationFor(selected?.id);
          draggedRing?.beginExternalDrag(axis === 'X' ? 0 : axis === 'Y' ? 1 : axis === 'Z' ? 2 : -1);
        }
        for (const { target } of points) target.setInteractive(false);
      };
      driver.onDragChange = () => {
        if (!selected) return;
        if (controlMode(selected) === 'move') {
          selected.target.reclamp();
        } else if (draggedRing) {
          draggedRing.quaternion.copy(selected.target.quaternion);
          draggedRing.updateExternalDrag();
        } else if (!legacy) {
          if (selected.channels) selected.rotationEnabled = true;
          if (selected.rotationEnabled) recordEdit(selected);
        }
      };
      driver.onDragEnd = endGizmoDrag;

      const pickNearest = (event: PointerEvent) => {
        blankPress = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
        const bounds = dom.getBoundingClientRect();
        cursor.set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
        raycaster.setFromCamera(cursor, ctx.camera);
        let nearest: DragTarget | undefined;
        let distance = Infinity;
        if (event.button === 0 && options.showGizmos) {
          for (const { target } of points) {
            if (!target.ball.visible) continue;
            const next = raycaster.ray.distanceSqToPoint(target.getWorldPosition(delta));
            if (next < distance) {
              distance = next;
              nearest = target;
            }
          }
        }
        const hitsOtherMarker = nearest && nearest !== driver.attachedTo
          && distance <= (nearest.ballRadius * nearest.ball.scale.x) ** 2;
        const yieldGizmo = hitsOtherMarker && driver.controls.enabled;
        if (yieldGizmo) driver.controls.enabled = false;
        for (const { target } of points) target.setInteractive(target === nearest);
        window.setTimeout(() => {
          if (yieldGizmo) driver.controls.enabled = true;
          for (const { target } of points) target.setInteractive(true);
        }, 0);
      };
      const onPointerUp = (event: PointerEvent) => {
        legacy?.endMove();
        const press = blankPress;
        blankPress = null;
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) selectPoint(null);
      };
      dom.addEventListener('pointerdown', pickNearest, true);
      dom.addEventListener('pointerup', onPointerUp);

      const getEffector = (point: ControlPoint) => point.endSite ?? bones.get(point.boneName)!;
      const syncTarget = (point: ControlPoint) => {
        const effector = getEffector(point);
        effector.getWorldPosition(point.target.position);
        (legacy?.rotationFor(point.id) ?? effector).getWorldQuaternion(point.target.quaternion);
        point.previousPosition.copy(point.target.position);
      };
      const bindEndSite = (point: ControlPoint) => {
        point.endSite?.removeFromParent();
        point.endSite = undefined;
        const landmark = point.landmark ? landmarks.get(point.landmark) : undefined;
        if (landmark && landmark.bone === bones.get(point.boneName)) {
          const endSite = new Object3D();
          endSite.position.copy(landmark.offset);
          landmark.bone.add(endSite);
          point.endSite = endSite;
        }
        syncTarget(point);
      };
      const removePoint = (point: ControlPoint) => {
        if (activeTorsoEdit === point) activeTorsoEdit = null;
        if (selected === point) selectPoint(null);
        points.delete(point);
        point.endSite?.removeFromParent();
        point.folder.destroy();
        point.target.dispose();
        point.target.removeFromParent();
        point.target.ball.geometry.dispose();
        const materials = point.target.ball.material;
        for (const material of Array.isArray(materials) ? materials : [materials]) material.dispose();
      };

      const modeControl = gui.add(options, 'mode', { '移动 (W)': 'move', '旋转 (E)': 'rotate' })
        .name('操纵器').onChange(refreshGizmos);
      if (!legacy) {
        const stabilityControl = gui.add(stabilitySettings, 'torsoStability', 0, 100, 5).name('躯干稳定 (%)');
        stabilityControl.disable(stabilitySettings.lockTorso);
        gui.add(stabilitySettings, 'lockTorso').name('拖四肢时固定躯干').onChange((locked: boolean) => {
          stabilityControl.disable(locked);
          activeTorsoEdit = null;
          editingTorso = false;
          captureTorso();
        });
        gui.add(options, 'bone', boneOptions).name('选择骨骼');
        gui.add({ add: () => addPoint(defaultControl(options.bone), true) }, 'add').name('添加控制点');
      }
      gui.add(options, 'showGizmos').name('显示控制点').onChange(refreshGizmos);
      gui.add(view, 'showAll').name('显示全部控制点').onChange(refreshGizmos);
      gui.add({ reset: () => {
        root.position.set(0, 0, 0);
        rig.resetToRest();
        root.updateWorldMatrix(true, true);
        legacy?.reset();
        for (const point of points) syncTarget(point);
        editingTorso = false;
        activeTorsoEdit = null;
        captureTorso();
      } }, 'reset').name('重置姿势');

      function addPoint(settings: ControlSettings, select = false): void {
        const radius = settings.tier ? MARKER_RADII[settings.tier] : undefined;
        const target = new DragTarget(ctx.camera, dom, new Vector3(), POSE_CONTROL_COLOR, ctx.dragControl, radius);
        setPoseMarkerShape(target, settings.channels);
        target.name = settings.label;
        ctx.scene.add(target);
        const folder = gui.addFolder(settings.label);
        const point: ControlPoint = { ...settings, target, folder, previousPosition: new Vector3() };
        points.add(point);
        bindEndSite(point);
        target.onPress = () => selectPoint(point);
        target.onMoved = () => {
          if (legacy && point.id) {
            legacy.move(point.id, getEffector(point), target, point.previousPosition);
            point.previousPosition.copy(target.position);
            return;
          }
          if (![...points].some(control => control.positionEnabled)) {
            root.position.add(delta.subVectors(target.position, point.previousPosition));
            captureTorso();
          } else if (point.channels && point.channels !== 'rotation') {
            point.positionEnabled = true;
          }
          if (point.positionEnabled) recordEdit(point);
          point.previousPosition.copy(target.position);
        };
        folder.add(point, 'label').name('名称').onChange((value: string) => { folder.title(value); target.name = value; });
        if (!legacy) {
          folder.add(point, 'boneName', boneOptions).name('骨骼').onChange(() => bindEndSite(point));
          if (point.channels !== 'rotation') folder.add(point, 'positionEnabled').name('约束位置').listen().onChange(() => {
            getEffector(point).getWorldPosition(target.position);
            point.previousPosition.copy(target.position);
          });
          if (point.channels !== 'position') folder.add(point, 'rotationEnabled').name('约束旋转').listen().onChange((enabled: boolean) => {
            if (enabled) getEffector(point).getWorldQuaternion(target.quaternion);
          });
          folder.add({ remove: () => removePoint(point) }, 'remove').name('移除控制点');
        }
        if (select) selectPoint(point);
        else { folder.close(); refreshGizmos(); }
      }

      for (const settings of savedControls) addPoint(settings);
      const onKey = (event: KeyboardEvent) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable]')) return;
        if (event.key.toLowerCase() === 'w') modeControl.setValue('move');
        else if (event.key.toLowerCase() === 'e') modeControl.setValue('rotate');
        else if (event.key === 'Escape') selectPoint(null);
      };
      window.addEventListener('keydown', onKey);

      const solveFullbody = () => {
        const constraints: IKConstraint[] = [];
        const support: Vector3[] = [];
        for (const point of points) {
          const { boneName, endSite, positionEnabled, rotationEnabled, target } = point;
          const effector = getEffector(point);
          if (!endSite && /foot|toe/i.test(boneName)) support.push(positionEnabled ? target.position : effector.getWorldPosition(new Vector3()));
          if (positionEnabled || rotationEnabled) constraints.push({
            effector, root: hips, target: target.position, targetRot: target.quaternion,
            posWeight: Number(positionEnabled), rotWeight: Number(rotationEnabled),
          });
        }
        const lockTorso = stabilitySettings.lockTorso && !activeTorsoEdit;
        const stability = editingTorso || lockTorso ? 0 : stabilitySettings.torsoStability / 100;
        if (stability > 0 && constraints.length) {
          const [pelvis, chest] = torsoAnchors;
          constraints.push(
            { ...pelvis, posWeight: 2 * stability, rotWeight: 0.65 * stability },
            { ...chest, posWeight: stability, rotWeight: 0.8 * stability },
          );
        }
        solveIK(constraints, 6, 0.12, {
          allowRootTranslation: !lockTorso, lockedBones: lockTorso ? lockedTorsoBones : undefined,
          rootStep: 0.15 * (1 - 0.3 * stability), rootClamp: 0.06, comSupport: support,
          comGain: 0.03 * (1 - stability), rotGain: 0.5,
        });
        if (activeTorsoEdit && !activeTorsoEdit.target.isDragging) activeTorsoEdit = null;
      };
      const unsubscribe = ctx.onFrame(() => {
        if (legacy) legacy.update();
        else solveFullbody();
        ctx.camera.getWorldQuaternion(cameraRotation);
        for (const point of points) {
          const { channels, positionEnabled, rotationEnabled, target, previousPosition } = point;
          if (!target.isDragging) {
            if (legacy) syncTarget(point);
            else {
              const effector = getEffector(point);
              if (!positionEnabled) effector.getWorldPosition(target.position);
              if (!rotationEnabled) effector.getWorldQuaternion(target.quaternion);
              previousPosition.copy(target.position);
            }
          }
          if (channels === 'rotation') target.ball.quaternion.copy(target.quaternion).invert().multiply(cameraRotation);
        }
      });

      const debug = (window as unknown as { __threeik: Record<string, unknown> }).__threeik;
      debug.rig = rig;
      debug.poseIk = { engine, points, root };
      if (legacy) debug.ctl = legacy.controls;
      else debug.fullbodyIk = debug.poseIk;
      dispose = () => {
        savedControls = [...points].map(({ id, label, boneName, channels, tier, landmark, positionEnabled, rotationEnabled }) => ({
          id, label, boneName, channels, tier, landmark, positionEnabled, rotationEnabled,
        }));
        unsubscribe();
        dom.removeEventListener('pointerdown', pickNearest, true);
        dom.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('keydown', onKey);
        for (const point of points) removePoint(point);
        driver.dispose();
        legacy?.controls.dispose();
        gui.destroy();
        delete debug.ctl;
        delete debug.poseIk;
        delete debug.fullbodyIk;
        loaded.root.removeFromParent();
        loaded.helper.removeFromParent();
      };
    },

    capturePose() {
      return character ? captureCharacterPose(character) : undefined;
    },

    unmount() {
      version++;
      dispose?.();
      dispose = undefined;
      character = null;
    },
  };
}
