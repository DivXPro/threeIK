import { describe, it, expect, vi } from 'vitest';
import { MeshBasicMaterial, Object3D, SphereGeometry, Vector3 } from 'three';
import { DragTarget, MARKER_SELECTED_COLOR } from '../../src/controls/drag-target';
import { PoleOrbit } from '../../src/controls/pole-orbit';
import { makeCamera, makeDomStub } from './test-utils';

const colorOf = (t: DragTarget) => (t.ball.material as MeshBasicMaterial).color.getHex();

function anchorAt(x: number, y: number, z: number) {
  const o = new Object3D();
  o.position.set(x, y, z);
  return o;
}

describe('DragTarget', () => {
  it('setColor：常态立即生效；选中高亮中保持亮黄，取消选中落回新本色；大小不受影响', () => {
    const t = new DragTarget(makeCamera(), makeDomStub(), new Vector3(), 0xff0000);
    expect(colorOf(t)).toBe(0xff0000);
    t.setColor(0x00ff00);
    expect(colorOf(t)).toBe(0x00ff00);
    // 标记 + 选中 = 高亮中：换色不改当前显示，取消选中后落回新本色
    t.setMarkerMode(true);
    t.setSelected(true);
    expect(colorOf(t)).toBe(MARKER_SELECTED_COLOR);
    t.setColor(0x0000ff);
    expect(colorOf(t)).toBe(MARKER_SELECTED_COLOR);
    t.setSelected(false);
    expect(colorOf(t)).toBe(0x0000ff);
    expect(t.ball.scale.x).toBe(1); // 全程不动大小
    t.dispose();
  });

  it('PoleOrbit.setColor：运行期换 pole 球颜色', () => {
    const anchor = new Object3D();
    const axisTo = new Object3D();
    axisTo.position.set(0, 1, 0);
    const pole = new PoleOrbit(makeCamera(), makeDomStub(), { color: 0xffcc00 });
    pole.bind(anchor, axisTo);
    expect((pole.ball.material as MeshBasicMaterial).color.getHex()).toBe(0xffcc00);
    pole.setColor(0x123456);
    expect((pole.ball.material as MeshBasicMaterial).color.getHex()).toBe(0x123456);
    pole.dispose();
  });

  it('初始摆位 + 默认/自定义视觉球半径', () => {
    const camera = makeCamera();
    const dom = makeDomStub();
    const t = new DragTarget(camera, dom, new Vector3(1, 2, 3), 0xff5533);
    expect(t.position.distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    expect(t.ballRadius).toBeCloseTo(0.0225, 6);
    const big = new DragTarget(camera, dom, new Vector3(), 0xff5533, undefined, 0.05);
    expect(big.ballRadius).toBeCloseTo(0.05, 6);
    expect((big.ball.geometry as SphereGeometry).parameters.radius).toBeCloseTo(0.05, 6);
  });

  it('可达钳制：setReachConstraint 立即收回球面，moveTo 超界被收拢', () => {
    const t = new DragTarget(makeCamera(), makeDomStub(), new Vector3(5, 0, 0));
    t.setReachConstraint(anchorAt(0, 0, 0), 1);
    expect(t.position.length()).toBeCloseTo(1, 6);
    t.moveTo(new Vector3(0, 5, 0));
    expect(t.position.length()).toBeCloseTo(1, 6);
    expect(t.position.y).toBeCloseTo(1, 6);
    // 球内移动不受限
    t.moveTo(new Vector3(0.3, 0, 0));
    expect(t.position.distanceTo(new Vector3(0.3, 0, 0))).toBeLessThan(1e-6);
  });

  it('方向锥 min=max=R：球恒距锚点 R，出锥方向被收拢到锥面', () => {
    const t = new DragTarget(makeCamera(), makeDomStub(), new Vector3(0, 0, 2));
    const anchor = anchorAt(0, 0, 0);
    const angle = Math.PI / 6; // 30°
    t.setConeConstraint(anchor, new Vector3(0, 0, 1), angle, 0.5, 0.5);
    // 锥内轴向：距离收到 0.5
    expect(t.position.length()).toBeCloseTo(0.5, 6);
    expect(t.position.z).toBeCloseTo(0.5, 6);
    // 90° 偏轴（出锥）：收拢到 30° 锥面，距离仍 0.5
    t.moveTo(new Vector3(0, 2, 0));
    expect(t.position.length()).toBeCloseTo(0.5, 6);
    expect(t.position.y).toBeCloseTo(0.5 * Math.sin(angle), 6);
    expect(t.position.z).toBeCloseTo(0.5 * Math.cos(angle), 6);
  });

  it('携带：锚点移动后 carryAlong 保持相对偏移', () => {
    const anchor = anchorAt(1, 0, 0);
    const t = new DragTarget(makeCamera(), makeDomStub(), new Vector3(1.5, 0, 0));
    t.setCarry(anchor);
    anchor.position.set(2, 0, 0);
    t.carryAlong();
    expect(t.position.distanceTo(new Vector3(2.5, 0, 0))).toBeLessThan(1e-6);
  });

  it('携带 + 钳制组合：偏移被钳制改写后按实际位置重记', () => {
    const anchor = anchorAt(0, 0, 0);
    const t = new DragTarget(makeCamera(), makeDomStub(), new Vector3(0.5, 0, 0));
    t.setReachConstraint(anchor, 1);
    t.setCarry(anchor);
    anchor.position.set(10, 0, 0); // 锚点跳远：偏移 (0.5,0,0) 仍在球内
    t.carryAlong();
    expect(t.position.distanceTo(new Vector3(10.5, 0, 0))).toBeLessThan(1e-6);
  });

  it('指针拖拽：命中开拖锁视角，移动写位置，松手解锁', () => {
    const camera = makeCamera();
    const dom = makeDomStub();
    const dragControl = { lock: vi.fn(), unlock: vi.fn() };
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0), 0xff5533, dragControl);
    dom.fire('pointerdown', { clientX: 400, clientY: 300 }); // 屏幕中心 = 球心
    expect(t.isDragging).toBe(true);
    expect(dragControl.lock).toHaveBeenCalledTimes(1);
    dom.fire('pointermove', { clientX: 500, clientY: 300 }); // 向右拖
    expect(t.position.x).toBeGreaterThan(0.01);
    expect(Math.abs(t.position.y)).toBeLessThan(1e-6);
    dom.fire('pointerup', {});
    expect(t.isDragging).toBe(false);
    expect(dragControl.unlock).toHaveBeenCalledTimes(1);
  });

  it('未命中不开拖（容差按相机距离换算）', () => {
    const dom = makeDomStub();
    const t = new DragTarget(makeCamera(), dom, new Vector3(0, 0, 0));
    dom.fire('pointerdown', { clientX: 100, clientY: 100 }); // 远离屏幕中心
    expect(t.isDragging).toBe(false);
  });

  it('dispose：移除监听器；拖拽中途 dispose 也归还视角控制', () => {
    const dom = makeDomStub();
    const dragControl = { lock: vi.fn(), unlock: vi.fn() };
    const t = new DragTarget(makeCamera(), dom, new Vector3(0, 0, 0), 0xff5533, dragControl);
    dom.fire('pointerdown', { clientX: 400, clientY: 300 });
    t.dispose();
    expect(dom.listenerCount('pointerdown')).toBe(0);
    expect(dom.listenerCount('pointermove')).toBe(0);
    expect(dom.listenerCount('pointerup')).toBe(0);
    expect(dragControl.unlock).toHaveBeenCalledTimes(1);
    // dispose 后事件不再生效
    dom.fire('pointerdown', { clientX: 400, clientY: 300 });
    expect(t.isDragging).toBe(false);
  });

  it('reclamp：外部写入的位置过钳制回写，携带偏移同步刷新', () => {
    const dom = makeDomStub();
    const camera = makeCamera();
    const scene = new Object3D();
    const anchor = new Object3D();
    scene.add(anchor);
    scene.updateMatrixWorld(true);
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    scene.add(t);
    t.setReachConstraint(anchor, 0.5);
    t.setCarry(anchor);
    // 模拟外部操纵器（TC）直接改写位置——不经过拖拽路径
    t.position.set(2, 0, 0);
    t.reclamp();
    expect(t.position.length()).toBeCloseTo(0.5, 6); // 收回可达球面
    // 携带偏移按钳制后的实际位置重记：锚点平移后保持相对偏移
    anchor.position.set(1, 0, 0);
    anchor.updateMatrixWorld(true);
    t.carryAlong();
    expect(t.position.distanceTo(new Vector3(1.5, 0, 0))).toBeLessThan(1e-6);
  });

  it('外部拖拽期间 carryAlong 暂停、isDragging 为 true，endExternalDrag 后恢复', () => {
    const dom = makeDomStub();
    const camera = makeCamera();
    const scene = new Object3D();
    const anchor = new Object3D();
    scene.add(anchor);
    scene.updateMatrixWorld(true);
    const t = new DragTarget(camera, dom, new Vector3(0.3, 0, 0));
    scene.add(t);
    t.setCarry(anchor);
    t.beginExternalDrag();
    expect(t.isDragging).toBe(true);
    anchor.position.set(1, 0, 0);
    anchor.updateMatrixWorld(true);
    t.carryAlong();
    expect(t.position.x).toBeCloseTo(0.3, 6); // 拖拽中不携带
    t.endExternalDrag();
    expect(t.isDragging).toBe(false);
    t.carryAlong();
    expect(t.position.x).toBeCloseTo(1.3, 6); // 恢复携带
  });

  it('外部操纵器接管（setExternalManipulator）：按下只触发 onPress，不进入拖拽', () => {
    const dom = makeDomStub();
    const camera = makeCamera(); // 默认相机朝原点看：世界原点 = 屏幕中心 (400,300)
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    const scene = new Object3D();
    scene.add(t);
    scene.updateMatrixWorld(true);
    const onPress = vi.fn();
    t.onPress = onPress;
    t.setExternalManipulator(true);
    dom.fire('pointerdown', {});
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(t.isDragging).toBe(false);
    dom.fire('pointermove', { clientX: 420, clientY: 300 });
    expect(t.position.length()).toBeLessThan(1e-6); // 没有拖动
  });
});
