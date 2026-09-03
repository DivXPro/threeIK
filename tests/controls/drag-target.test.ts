import { describe, it, expect, vi } from 'vitest';
import { Object3D, SphereGeometry, Vector3 } from 'three';
import { DragTarget } from '../../src/controls/drag-target';
import { makeCamera, makeDomStub } from './test-utils';

function anchorAt(x: number, y: number, z: number) {
  const o = new Object3D();
  o.position.set(x, y, z);
  return o;
}

describe('DragTarget', () => {
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
});
