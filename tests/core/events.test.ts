import { describe, it, expect, vi } from 'vitest';
import { TinyEmitter } from '../../src/core/events';
import { ThreeIKError } from '../../src/core/errors';

describe('TinyEmitter', () => {
  it('calls listeners and unsubscribes', () => {
    const em = new TinyEmitter<'rest-updated' | 'warning'>();
    const cb = vi.fn();
    const off = em.on('rest-updated', cb);
    em.emit('rest-updated');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    em.emit('rest-updated');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('warnOnce emits one warning per key', () => {
    const em = new TinyEmitter<'warning'>();
    const cb = vi.fn();
    em.on('warning', cb);
    em.warnOnce('nan-target', 'target is NaN');
    em.warnOnce('nan-target', 'target is NaN');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toMatchObject({ key: 'nan-target' });
    em.clearWarnings();
    em.warnOnce('nan-target', 'target is NaN');
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('ThreeIKError', () => {
  it('carries code and descriptive message', () => {
    const e = ThreeIKError.boneNotFound('LeftHand');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('BONE_NOT_FOUND');
    expect(e.message).toContain('LeftHand');
  });
});
