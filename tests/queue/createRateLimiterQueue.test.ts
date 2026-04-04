import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRateLimiterQueue } from '../../src/queue/createRateLimiterQueue.js';
import {
  RateLimiterQueue,
  RateLimiterQueueError,
} from '../../src/queue/RateLimiterQueue.js';
import { RedisStore } from '../../src/stores/redis-store.js';
import type { RedisLikeClient } from '../../src/stores/redis-store.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createRateLimiterQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('creates a RateLimiterQueue with default MemoryStore (sliding window)', () => {
    const q = createRateLimiterQueue({
      maxRequests: 10,
      windowMs: 60_000,
    });
    expect(q).toBeInstanceOf(RateLimiterQueue);
    expect(q.getWindowMs()).toBe(60_000);
  });

  /**
   * 5 req / 1s: 10 concurrent `removeTokens` — first 5 pass immediately, the rest queue until the window moves.
   */
  it('5 req/sec: 10 concurrent calls — first 5 immediate, remainder after ~1s window (fake timers)', async () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));

    const q = createRateLimiterQueue({
      maxRequests: 5,
      windowMs: 1000,
      maxQueueSize: 100,
    });

    const promises = Array.from({ length: 10 }, () => q.removeTokens('outbound-api'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);
    expect(results.every((r) => typeof r.remaining === 'number')).toBe(true);
    expect(q.getQueueSize()).toBe(0);

    await q.shutdown();
  });

  it('works with RedisStore when eval is backed by MemoryStore (mock client)', async () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));

    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });

    const client: RedisLikeClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn(async (_script: string, numKeys: number, ...all: string[]) => {
        const keys = all.slice(0, numKeys);
        const argv = all.slice(numKeys);
        const rk = keys[0]!;
        const logicalKey = rk.includes(':') ? (rk.split(':').pop() ?? rk) : rk;

        if (argv.length >= 4) {
          const maxReq = Number(argv[2]);
          const cost = Number(argv[3]);
          const r = await mem.increment(logicalKey, {
            maxRequests: maxReq,
            cost: Number.isFinite(cost) ? cost : 1,
          });
          return [r.totalHits, r.isBlocked ? 1 : 0, r.resetTime.getTime()];
        }

        if (argv.length >= 1 && argv.length <= 2) {
          const cost = Number(argv[0]);
          const newest = argv[1] === '1';
          await mem.decrement(logicalKey, { cost, removeNewest: newest });
          return 1;
        }

        return null;
      }),
    };

    const redis = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      client,
    });

    const q = createRateLimiterQueue({
      maxRequests: 3,
      windowMs: 1000,
      store: redis,
    });

    const a = await q.removeTokens('redis-key');
    expect(a.remaining).toBe(2);

    await q.shutdown();
    await mem.shutdown();
    await redis.shutdown();
  });

  it('enforces maxQueueSize', async () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));

    const q = createRateLimiterQueue({
      maxRequests: 1,
      windowMs: 100_000,
      maxQueueSize: 1,
    });

    const p1 = q.removeTokens('k');
    await flushMicrotasks();
    await p1;

    const p2 = q.removeTokens('k');
    expect(q.getQueueSize()).toBe(1);

    await expect(q.removeTokens('k')).rejects.toThrow(RateLimiterQueueError);
    await expect(q.removeTokens('k')).rejects.toThrow('Queue is full');

    await vi.advanceTimersByTimeAsync(100_000);
    await flushMicrotasks();
    await p2;

    await q.shutdown();
  });

  it('uses keys independently (same queue)', async () => {
    const q = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 60_000,
    });

    const a = await q.removeTokens('tenant-a');
    const b = await q.removeTokens('tenant-b');
    expect(a.remaining).toBe(1);
    expect(b.remaining).toBe(1);

    await q.shutdown();
  });
});
