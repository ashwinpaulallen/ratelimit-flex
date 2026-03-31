import { describe, expect, it } from 'vitest';
import { MetricsCounters } from '../../src/metrics/counters.js';
import { MetricsManager } from '../../src/metrics/manager.js';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitEngine } from '../../src/strategies/rate-limit-engine.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function slidingStore() {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 1_000_000,
  });
}

describe('metrics overhead', () => {
  it('engine without vs with MetricsCounters: both complete 10K consumes; metrics records totals', async () => {
    const optsNo = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1_000_000,
      store: slidingStore(),
    });
    const optsYes = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1_000_000,
      store: slidingStore(),
    });

    const engineNo = new RateLimitEngine(optsNo, undefined);
    const counters = new MetricsCounters();
    const engineYes = new RateLimitEngine(optsYes, counters);

    const n = 10_000;
    for (let i = 0; i < n; i++) {
      await engineNo.consumeWithKey(`n-${i}`, {});
    }
    for (let i = 0; i < n; i++) {
      await engineYes.consumeWithKey(`y-${i}`, {});
    }

    expect(counters.totalRequests).toBe(n);
    expect(counters.allowedRequests).toBe(n);

    await optsNo.store.shutdown();
    await optsYes.store.shutdown();
  });

  it('100K totalRequests increments complete quickly (no recordLatency)', () => {
    const c = new MetricsCounters();
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      c.totalRequests++;
    }
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('metrics disabled does not allocate MetricsCounters; getSnapshot is null', () => {
    const mm = new MetricsManager(false);
    expect(mm.getCounters()).toBeNull();
    expect(mm.getSnapshot()).toBeNull();
    expect(mm.isEnabled()).toBe(false);
  });
});
