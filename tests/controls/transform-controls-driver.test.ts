import { describe, it, expect, vi } from 'vitest';
import { Object3D } from 'three';
import { TransformControlsDriver } from '../../src/controls/transform-controls-driver';
import { makeCamera, makeDomStub } from './test-utils';

function makeDriver() {
  const scene = new Object3D();
  const dom = makeDomStub();
  const dragControl = { lock: vi.fn(), unlock: vi.fn() };
  const driver = new TransformControlsDriver(makeCamera(), scene, dom, dragControl);
  return { scene, dom, dragControl, driver };
}

describe('TransformControlsDriver', () => {
  it('构造：helper 挂进场景（getHelper shim），XYZE 自由轨球通道移除', () => {
    const { scene, driver } = makeDriver();
    expect(scene.children).toHaveLength(1);
    let xyzCount = 0;
    scene.traverse((o) => { if (o.name === 'XYZE') xyzCount++; });
    expect(xyzCount).toBe(0);
    driver.dispose();
  });

  it('setMode 映射 space：rotate→local、move→world', () => {
    const { driver } = makeDriver();
    driver.setMode('rotate');
    expect(driver.controls.space).toBe('local');
    driver.setMode('move');
    expect(driver.controls.mode).toBe('translate');
    expect(driver.controls.space).toBe('world');
    driver.dispose();
  });

  it('attach 选项：axes 子集映射 showX/Y/Z；viewRing:false 移除 E 通道，viewRing:true 恢复', () => {
    const { scene, driver } = makeDriver();
    const target = new Object3D();
    driver.attach(target, { axes: [true, true, false], viewRing: false });
    expect(driver.attachedTo).toBe(target);
    expect(driver.controls.showZ).toBe(false);
    let eCount = 0;
    scene.traverse((o) => { if (o.name === 'E') eCount++; });
    expect(eCount).toBe(0);
    driver.attach(target, { viewRing: true });
    eCount = 0;
    scene.traverse((o) => { if (o.name === 'E') eCount++; });
    expect(eCount).toBeGreaterThan(0);
    driver.attach(null);
    expect(driver.attachedTo).toBeNull();
    driver.dispose();
  });

  it('事件翻译：mouseDown/objectChange/mouseUp → onDragStart({axis})/onDragChange/onDragEnd', () => {
    const { driver } = makeDriver();
    const calls: string[] = [];
    driver.onDragStart = (info) => calls.push(`start:${info.axis}`);
    driver.onDragChange = () => calls.push('change');
    driver.onDragEnd = () => calls.push('end');
    (driver.controls as unknown as { axis: string }).axis = 'X';
    driver.controls.dispatchEvent({ type: 'mouseDown' } as never);
    driver.controls.dispatchEvent({ type: 'objectChange' } as never);
    driver.controls.dispatchEvent({ type: 'mouseUp' } as never);
    expect(calls).toEqual(['start:X', 'change', 'end']);
    driver.dispose();
  });

  it('dragging-changed 接 dragControl 视角锁（成对，重复 true 不叠加）', () => {
    const { driver, dragControl } = makeDriver();
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: true } as never);
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: true } as never);
    expect(dragControl.lock).toHaveBeenCalledTimes(1);
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: false } as never);
    expect(dragControl.unlock).toHaveBeenCalledTimes(1);
    driver.dispose();
  });

  it('dispose：归还视角锁、helper 离场、dom 监听移除', () => {
    const { scene, dom, driver, dragControl } = makeDriver();
    driver.controls.dispatchEvent({ type: 'dragging-changed', value: true } as never);
    const before = dom.listenerCount('pointerdown');
    driver.dispose();
    expect(dragControl.unlock).toHaveBeenCalledTimes(1); // 拖拽中途 dispose 也还锁
    expect(scene.children).toHaveLength(0);
    expect(dom.listenerCount('pointerdown')).toBeLessThan(before);
  });
});
