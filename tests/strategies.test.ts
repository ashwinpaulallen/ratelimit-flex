import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/stores/memory-store.js';
import {
  RateLimitEngine,
  createRateLimiter as createEngineRateLimiter,
  defaultKeyGenerator,
  resolveIncrementOpts,
} from '../src/strategies/rate-limit-engine.js';
import type { RateLimitOptions } from '../src/types/index.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('RateLimitEngine / strategies', () => {
  it('enforces sliding window strategy', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
    });
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
      store,
    });

    const r1 = await engine.consume('k');
    const r2 = await engine.consume('k');
    const r3 = await engine.consume('k');

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(false);
    expect(r3.isBlocked).toBe(true);

    await store.shutdown();
  });

  it('enforces fixed window strategy', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store,
    });

    const r1 = await engine.consume('k');
    const r2 = await engine.consume('k');

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(true);
    await store.shutdown();
  });

  it('enforces token bucket strategy', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: 1,
        interval: 1000,
        bucketSize: 1,
      });
      const engine = new RateLimitEngine({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: 1,
        interval: 1000,
        bucketSize: 1,
        store,
      });

      const r1 = await engine.consume('k');
      const r2 = await engine.consume('k');
      expect(r1.isBlocked).toBe(false);
      expect(r2.isBlocked).toBe(true);

      vi.advanceTimersByTime(1000);
      const r3 = await engine.consume('k');
      expect(r3.isBlocked).toBe(false);
      await store.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects incrementCost on the engine', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 5,
    });
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 5,
      incrementCost: 5,
      store,
    });

    const r1 = await engine.consume('k');
    const r2 = await engine.consume('k');
    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(true);
    await store.shutdown();
  });

  it('resolveIncrementOpts merges dynamic maxRequests and incrementCost', () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const opts = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: (req: unknown) => (req as { n: number }).n,
      incrementCost: 2,
      store,
    } as RateLimitOptions;
    expect(resolveIncrementOpts(opts, { n: 7 })).toEqual({ maxRequests: 7, cost: 2 });
  });

  it('uses key generation correctly', async () => {
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
      keyGenerator: (req) => String((req as { userId: string }).userId),
    });

    const r1 = await engine.consume({ userId: 'u1' });
    const r2 = await engine.consume({ userId: 'u1' });
    const r3 = await engine.consume({ userId: 'u2' });

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(true);
    expect(r3.isBlocked).toBe(false);
    expect(defaultKeyGenerator({ ip: '10.0.0.1' })).toBe('10.0.0.1');
    await store.shutdown();
  });

  it('calculates headers including Retry-After when blocked', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const engine = createEngineRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store,
    });

    const r1 = await engine.consume('hdr');
    const r2 = await engine.consume('hdr');

    expect(r1.headers['X-RateLimit-Limit']).toBe('1');
    expect(r1.headers['X-RateLimit-Remaining']).toBe('0');
    expect(r1.headers['X-RateLimit-Reset']).toBeTruthy();
    expect(r2.isBlocked).toBe(true);
    expect(r2.headers['Retry-After']).toBeTruthy();
    await store.shutdown();
  });

  it('fires onLimitReached callback when blocked', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const onLimitReached = vi.fn();
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store,
      onLimitReached,
    });

    await engine.consume('cb');
    await engine.consume('cb');

    expect(onLimitReached).toHaveBeenCalledTimes(1);
    await store.shutdown();
  });

  it('handles async onLimitReached callback', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const logs: string[] = [];
    const onLimitReached = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      logs.push('blocked');
    });
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store,
      onLimitReached,
    });

    await engine.consume('async-cb');
    await engine.consume('async-cb');

    expect(onLimitReached).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['blocked']);
    await store.shutdown();
  });

  it('disables headers when headers: false', async () => {
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
      headers: false,
    });

    const r1 = await engine.consume('no-headers');
    expect(r1.headers).toEqual({});
    await store.shutdown();
  });
});
