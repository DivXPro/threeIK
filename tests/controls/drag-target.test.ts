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

  // 世界坐标 → 桩屏幕坐标（800×600）
  function clientFor(camera: ReturnType<typeof makeCamera>, world: Vector3) {
    const v = world.clone().project(camera);
    return { clientX: ((v.x + 1) / 2) * 800, clientY: ((-v.y + 1) / 2) * 600, pointerId: 1 };
  }

  it('轴箭头：拖 X 箭头只沿 X 移动（垂直屏幕位移不产生 y/z 分量）', () => {
    const camera = makeCamera(); // (0,0,5) 朝 -Z 看原点
    const dom = makeDomStub();
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    t.setAxisHandles(true, 1);
    t.setSelected(true); // 箭头只在选中后显示（Maya 同款）
    // 点 X 箭头中点 (0.6,0,0) 的屏幕位置 → 轴拖拽（t0=0.6）
    dom.fire('pointerdown', clientFor(camera, new Vector3(0.6, 0, 0)));
    expect(t.isDragging).toBe(true);
    // 拖到 (1.0,0.5,0) 的屏幕位置：垂直分量被投影掉，只剩 X 位移
    // （透视下射线相对 X 轴的最近参量略小于 1.0，t 容差放宽；语义由 y/z 精确为零背书）
    dom.fire('pointermove', clientFor(camera, new Vector3(1.0, 0.5, 0)));
    expect(t.position.x).toBeCloseTo(0.4, 1);
    expect(Math.abs(t.position.y)).toBeLessThan(1e-6);
    expect(Math.abs(t.position.z)).toBeLessThan(1e-6);
    dom.fire('pointerup', {});
  });

  it('轴箭头：箭头根部让位中心球；中心球仍走屏幕平面自由拖', () => {
    const camera = makeCamera();
    const dom = makeDomStub();
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    t.setAxisHandles(true, 1);
    t.setSelected(true);
    // 点箭头根部 (0.1,0,0)（< 0.25 杆长）：不算轴命中；距球心 0.1 超出球容差 → 不触发
    dom.fire('pointerdown', clientFor(camera, new Vector3(0.1, 0, 0)));
    expect(t.isDragging).toBe(false);
    // 点中心球 → 自由拖
    dom.fire('pointerdown', clientFor(camera, new Vector3(0, 0, 0)));
    expect(t.isDragging).toBe(true);
    dom.fire('pointermove', clientFor(camera, new Vector3(0.3, 0.4, 0)));
    expect(t.position.x).toBeCloseTo(0.3, 5);
    expect(t.position.y).toBeCloseTo(0.4, 5);
    dom.fire('pointerup', {});
  });

  it('轴箭头命中区 = 视觉杆长（updateFrame 缩放含 arrowLen，命中不再乘一次）', () => {
    const camera = makeCamera(); // (0,0,5) 朝 -Z 看原点，球在 dist=5
    const dom = makeDomStub();
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    t.setAxisHandles(true, 0.5); // arrowLen ≠ 1：旧 bug（命中长度 = arrowLen² × dist/REF）只有此时现形
    t.setSelected(true);
    t.updateFrame(); // 组缩放 = 0.5 × 5/3.5 ≈ 0.714 = 视觉杆长（单位几何总长 1）
    // 点杆 70% 处 (0.5,0,0)：在视觉杆上，必须命中（旧 bug 命中区只到 0.41，此处脱靶）
    dom.fire('pointerdown', clientFor(camera, new Vector3(0.5, 0, 0)));
    expect(t.isDragging).toBe(true);
    dom.fire('pointerup', {});
  });

  it('轴箭头高亮：hover 变色、移开恢复、拖拽期间保持、抬起复位', () => {
    const camera = makeCamera();
    const dom = makeDomStub();
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    t.setAxisHandles(true, 1);
    t.setSelected(true);
    // 读实例级箭头材质（私有字段，测试经箭头组子节点取 shaft 材质）
    const matOf = (i: number) => {
      const g = (t as unknown as { arrows: { group: Object3D } }).arrows.group;
      const arrow = g.children[i] as Object3D;
      return (arrow.children[0] as unknown as { material: { color: { getHex(): number } } }).material;
    };
    const baseX = matOf(0).color.getHex();
    const baseY = matOf(1).color.getHex();
    // hover X 杆 → X 变色，Y 不变
    dom.fire('pointermove', clientFor(camera, new Vector3(0.6, 0, 0)));
    expect(matOf(0).color.getHex()).not.toBe(baseX);
    expect(matOf(1).color.getHex()).toBe(baseY);
    // 移到无箭头处 → 恢复
    dom.fire('pointermove', clientFor(camera, new Vector3(-0.4, 0.9, 0)));
    expect(matOf(0).color.getHex()).toBe(baseX);
    // 拖 X 轴期间保持高亮（指针已不在杆上也保持）
    dom.fire('pointerdown', clientFor(camera, new Vector3(0.6, 0, 0)));
    dom.fire('pointermove', clientFor(camera, new Vector3(1.0, 0.5, 0)));
    expect(matOf(0).color.getHex()).not.toBe(baseX);
    // 抬起复位
    dom.fire('pointerup', {});
    expect(matOf(0).color.getHex()).toBe(baseX);
  });

  it('轴箭头随球显隐（rotate 模式隐藏后不可命中）', () => {
    const camera = makeCamera();
    const dom = makeDomStub();
    const t = new DragTarget(camera, dom, new Vector3(0, 0, 0));
    t.setAxisHandles(true, 1);
    t.setSelected(true);
    t.setVisible(false);
    dom.fire('pointerdown', clientFor(camera, new Vector3(0.6, 0, 0)));
    expect(t.isDragging).toBe(false);
    t.setVisible(true);
    dom.fire('pointerdown', clientFor(camera, new Vector3(0.6, 0, 0)));
    expect(t.isDragging).toBe(true);
    dom.fire('pointerup', {});
  });
});
