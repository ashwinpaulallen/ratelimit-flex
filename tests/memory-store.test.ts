import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('MemoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles sliding window limits and resets after window expiration', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });

    const r1 = await store.increment('k1');
    const r2 = await store.increment('k1');
    const r3 = await store.increment('k1');
    const r4 = await store.increment('k1');

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(false);
    expect(r3.isBlocked).toBe(false);
    expect(r4.isBlocked).toBe(true);

    vi.advanceTimersByTime(1001);
    const r5 = await store.increment('k1');
    expect(r5.isBlocked).toBe(false);
    expect(r5.totalHits).toBe(1);

    await store.shutdown();
  });

  it('handles token bucket consume, block, and refill', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 2,
      interval: 1000,
      bucketSize: 2,
    });

    const r1 = await store.increment('tb');
    const r2 = await store.increment('tb');
    const r3 = await store.increment('tb');

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(false);
    expect(r3.isBlocked).toBe(true);

    vi.advanceTimersByTime(1000);
    const r4 = await store.increment('tb');
    expect(r4.isBlocked).toBe(false);
    expect(r4.remaining).toBe(1);

    await store.shutdown();
  });

  it('handles fixed window counting and reset', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 1000,
      maxRequests: 2,
    });

    const r1 = await store.increment('fw');
    const r2 = await store.increment('fw');
    const r3 = await store.increment('fw');

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(false);
    expect(r3.isBlocked).toBe(true);

    vi.advanceTimersByTime(1001);
    const r4 = await store.increment('fw');
    expect(r4.isBlocked).toBe(false);
    expect(r4.totalHits).toBe(1);

    await store.shutdown();
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

  it('handles concurrent increments correctly', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 50,
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => {
        return store.increment('concurrent');
      }),
    );

    const blockedCount = results.filter((r) => r.isBlocked).length;
    const maxTotalHits = Math.max(...results.map((r) => r.totalHits));

    expect(blockedCount).toBe(50);
    expect(maxTotalHits).toBe(100);
    await store.shutdown();
  });
});
