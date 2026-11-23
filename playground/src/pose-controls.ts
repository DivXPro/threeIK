import { BoxGeometry, TorusGeometry } from 'three';
import type { DragTarget } from '@dreamerbird/threeik/controls';

const GROUPS: readonly (readonly string[])[] = [
  ['hips', 'spine', 'chest', 'hips:front', 'chest:front'],
  ['neck', 'head', 'head:front'],
  ['armL', 'armL:elbow', 'armL:root', 'armL:clavicle', 'armL:elbow-direction', 'armL:palm', 'armL:side'],
  ['armR', 'armR:elbow', 'armR:root', 'armR:clavicle', 'armR:elbow-direction', 'armR:palm', 'armR:side'],
  ['legL', 'legL:elbow', 'legL:root', 'legL:knee-direction', 'legL:heel', 'legL:toe', 'legL:side'],
  ['legR', 'legR:elbow', 'legR:root', 'legR:knee-direction', 'legR:heel', 'legR:toe', 'legR:side'],
];

export const POSE_CONTROL_COLOR = 0x7dd3c0;

export interface PoseControlView {
  showAll: boolean;
}

export function isPoseControlVisible(view: PoseControlView, name?: string, selected?: string | null): boolean {
  if (view.showAll || !name) return true;
  const group = GROUPS.find(controls => controls.includes(name));
  return !group || group[0] === name || (selected != null && group.includes(selected));
}

export function setPoseMarkerShape(target: DragTarget, channels?: 'position' | 'rotation' | 'both'): void {
  const radius = target.ballRadius;
  if (channels === 'position') {
    target.ball.geometry.dispose();
    const size = 1.6 * radius;
    target.ball.geometry = new BoxGeometry(size, size, size);
  } else if (channels === 'rotation') {
    target.ball.geometry.dispose();
    target.ball.geometry = new TorusGeometry(0.93 * radius, 0.13 * radius, 8, 24);
  }
}
