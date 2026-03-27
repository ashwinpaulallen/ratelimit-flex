import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RateLimitEngine } from '../src/strategies/rate-limit-engine.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('Edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles zero maxRequests gracefully', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 0,
    });

    const r1 = await store.increment('zero');
    expect(r1.isBlocked).toBe(true);
    expect(r1.remaining).toBe(0);
    await store.shutdown();
  });

  it('handles very large windowMs without overflow', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 365 * 24 * 60 * 60 * 1000,
      maxRequests: 1000,
    });

    const r1 = await store.increment('large-window');
    expect(r1.isBlocked).toBe(false);
    expect(r1.resetTime.getTime()).toBeGreaterThan(Date.now());
    await store.shutdown();
  });

  it('handles rapid successive increments on same key', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 1000,
      maxRequests: 5,
    });

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await store.increment('rapid'));
    }

    expect(results[4].isBlocked).toBe(false);
    expect(results[5].isBlocked).toBe(true);
    await store.shutdown();
  });

  it('handles token bucket with zero tokensPerInterval', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 0,
      interval: 1000,
      bucketSize: 2,
    });

    const r1 = await store.increment('zero-refill');
    const r2 = await store.increment('zero-refill');
    const r3 = await store.increment('zero-refill');

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(false);
    expect(r3.isBlocked).toBe(true);

    vi.advanceTimersByTime(1000);
    const r4 = await store.increment('zero-refill');
    expect(r4.isBlocked).toBe(true);

    await store.shutdown();
  });

  it('handles skip function that throws', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store,
      skip: () => {
        throw new Error('skip error');
      },
    });

    await expect(engine.consume('skip-error')).rejects.toThrow('skip error');
    await store.shutdown();
  });

  it('handles store.increment that throws', async () => {
    const failingStore = {
      async increment() {
        throw new Error('store error');
      },
      async decrement() {},
      async reset() {},
      async shutdown() {},
    };

    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store: failingStore,
    });

    await expect(engine.consume('store-error')).rejects.toThrow('store error');
  });

  it('handles multiple different keys independently', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });

    const r1a = await store.increment('key-a');
    const r1b = await store.increment('key-b');
    const r2a = await store.increment('key-a');
    const r2b = await store.increment('key-b');

    expect(r1a.isBlocked).toBe(false);
    expect(r1b.isBlocked).toBe(false);
    expect(r2a.isBlocked).toBe(true);
    expect(r2b.isBlocked).toBe(true);

    await store.shutdown();
  });

  it('handles reset correctly', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });

    await store.increment('reset-key');
    const r1 = await store.increment('reset-key');
    expect(r1.isBlocked).toBe(true);

    await store.reset('reset-key');
    const r2 = await store.increment('reset-key');
    expect(r2.isBlocked).toBe(false);

    await store.shutdown();
  });

  it('handles decrement on non-existent key', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    await expect(store.decrement('non-existent')).resolves.not.toThrow();
    await store.shutdown();
  });
});
