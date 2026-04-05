import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('KeyManager + InMemoryShield invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('KeyManager with shielded store: reward invalidates shield cache (decrement path)', async () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    });
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: 3,
      blockDurationMs: 60_000,
    });

    await shielded.increment('u');
    await shielded.increment('u');
    await shielded.increment('u');
    expect(shielded.isShielded('u')).toBe(true);

    const km = new KeyManager({
      store: shielded,
      maxRequests: 3,
      windowMs: 60_000,
    });
    await km.reward('u', 1);

    expect(shielded.isShielded('u')).toBe(false);

    await inner.shutdown();
    await shielded.shutdown();
    km.destroy();
  });

  it('KeyManager with raw store + shield option: reward invalidates via explicit unshield', async () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    });
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: 3,
      blockDurationMs: 60_000,
    });

    await shielded.increment('u');
    await shielded.increment('u');
    await shielded.increment('u');
    expect(shielded.isShielded('u')).toBe(true);

    const km = new KeyManager({
      store: inner,
      shield: shielded,
      maxRequests: 3,
      windowMs: 60_000,
    });
    await km.reward('u', 1);

    expect(shielded.isShielded('u')).toBe(false);

    await inner.shutdown();
    await shielded.shutdown();
    km.destroy();
  });

  it('KeyManager.unblock removes key from shield cache', async () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    });
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: 3,
      blockDurationMs: 60_000,
    });

    await shielded.increment('u');
    await shielded.increment('u');
    await shielded.increment('u');
    expect(shielded.isShielded('u')).toBe(true);

    const km = new KeyManager({
      store: shielded,
      maxRequests: 3,
      windowMs: 60_000,
    });
    await km.block('u', 5000, { type: 'manual' });
    expect(shielded.isShielded('u')).toBe(false);

    await shielded.increment('u');
    await shielded.increment('u');
    await shielded.increment('u');
    expect(shielded.isShielded('u')).toBe(true);

    await km.unblock('u');
    expect(shielded.isShielded('u')).toBe(false);

    await inner.shutdown();
    await shielded.shutdown();
    km.destroy();
  });

  it('KeyManager.delete removes key from shield cache', async () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    });
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: 3,
      blockDurationMs: 60_000,
    });

    await shielded.increment('d');
    await shielded.increment('d');
    await shielded.increment('d');
    expect(shielded.isShielded('d')).toBe(true);

    const km = new KeyManager({
      store: shielded,
      maxRequests: 3,
      windowMs: 60_000,
    });
    await km.delete('d');
    expect(shielded.isShielded('d')).toBe(false);

    await inner.shutdown();
    await shielded.shutdown();
    km.destroy();
  });

  it('KeyManager without shield option: operations do not throw', async () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const km = new KeyManager({
      store: inner,
      maxRequests: 10,
      windowMs: 60_000,
    });

    await expect(km.reward('x', 1)).resolves.toBeDefined();
    await expect(km.set('x', 0)).resolves.toBeDefined();
    await expect(km.block('y', 1000, { type: 'manual' })).resolves.toBeDefined();
    await expect(km.unblock('y')).resolves.toBeDefined();
    await expect(km.delete('x')).resolves.toBeDefined();

    km.destroy();
    await inner.shutdown();
  });
});
