import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { runStoreComplianceTests } from './compliance.js';
import type { StoreComplianceConfig } from './compliance.js';

runStoreComplianceTests({
  name: 'MemoryStore',
  async createStore(config: StoreComplianceConfig) {
    if (config.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: config.tokensPerInterval,
        interval: config.interval,
        bucketSize: config.bucketSize,
      });
    }
    return new MemoryStore({
      strategy: config.strategy,
      windowMs: config.windowMs,
      maxRequests: config.maxRequests,
    });
  },
});

describe('MemoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleans up expired sliding-window entries', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 100,
      maxRequests: 5,
    });

    await store.increment('cleanup-key');
    expect((store as unknown as { sliding: Map<string, number[]> }).sliding.size).toBe(1);

    vi.advanceTimersByTime(250);
    vi.runOnlyPendingTimers();

    expect((store as unknown as { sliding: Map<string, number[]> }).sliding.size).toBe(0);
    await store.shutdown();
  });

  it('sliding-window decrement removes the oldest hit (FIFO), not the newest', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    const t0 = Date.now();
    await store.increment('fifo');
    vi.advanceTimersByTime(1);
    await store.increment('fifo');
    vi.advanceTimersByTime(1);
    await store.increment('fifo');

    const sliding = (store as unknown as { sliding: Map<string, number[]> }).sliding;
    expect(sliding.get('fifo')).toEqual([t0, t0 + 1, t0 + 2]);

    await store.decrement('fifo');
    expect(sliding.get('fifo')).toEqual([t0 + 1, t0 + 2]);

    await store.shutdown();
  });

  describe('getActiveKeys / resetAll', () => {
    it('getActiveKeys returns correct entries after several increments', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 10_000,
        maxRequests: 100,
      });

      const t0 = Date.now();
      await store.increment('alpha');
      await store.increment('alpha');
      await store.increment('beta');

      const act = store.getActiveKeys();
      expect(act.size).toBe(2);
      expect(act.get('alpha')).toEqual({
        totalHits: 2,
        resetTime: new Date(t0 + 10_000),
      });
      expect(act.get('beta')).toEqual({
        totalHits: 1,
        resetTime: new Date(t0 + 10_000),
      });

      await store.shutdown();
    });

    it('getActiveKeys excludes expired sliding-window keys', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
      });

      await store.increment('gone');
      expect(store.getActiveKeys().has('gone')).toBe(true);

      vi.advanceTimersByTime(1001);
      expect(store.getActiveKeys().size).toBe(0);

      await store.shutdown();
    });

    it('getActiveKeys excludes expired fixed-window keys', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
      });

      await store.increment('fw');
      expect(store.getActiveKeys().has('fw')).toBe(true);

      vi.advanceTimersByTime(1001);
      expect(store.getActiveKeys().size).toBe(0);

      await store.shutdown();
    });

    it('resetAll clears all state and getActiveKeys is empty', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });

      await store.increment('x');
      await store.increment('y');
      expect(store.getActiveKeys().size).toBe(2);

      store.resetAll();
      expect(store.getActiveKeys().size).toBe(0);
      expect((store as unknown as { sliding: Map<string, unknown> }).sliding.size).toBe(0);

      const after = await store.increment('z');
      expect(after.totalHits).toBe(1);

      await store.shutdown();
    });
  });
});
