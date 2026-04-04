import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RateLimiterQueue,
  type RateLimiterQueueResult,
} from '../../src/queue/RateLimiterQueue.js';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

async function flushMicrotasksDeep(iterations = 256): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

/**
 * Minimal {@link RateLimitStore} double for cluster-style async increments without real IPC.
 */
class MockClusterLikeStore implements RateLimitStore {
  incrementCalls: Array<{ key: string; options?: RateLimitIncrementOptions }> = [];

  decrementCalls: Array<{ key: string; options?: RateLimitDecrementOptions }> = [];

  private attempt = 0;

  constructor(
    private readonly behavior: {
      /** First N increments return blocked; then success. */
      blockedPhases: number;
      windowMs: number;
    },
  ) {}

  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    this.incrementCalls.push({ key, options });
    this.attempt += 1;
    if (this.attempt <= this.behavior.blockedPhases) {
      return {
        totalHits: 99,
        remaining: 0,
        isBlocked: true,
        resetTime: new Date(Date.now() + this.behavior.windowMs),
      };
    }
    return {
      totalHits: 1,
      remaining: 0,
      isBlocked: false,
      resetTime: new Date(Date.now() + this.behavior.windowMs),
    };
  }

  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    this.decrementCalls.push({ key, options });
  }

  async reset(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe('RateLimiterQueue with ClusterStore-like store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('delegates removeTokens to store.increment', async () => {
    const store = new MockClusterLikeStore({ blockedPhases: 0, windowMs: 1000 });
    const q = new RateLimiterQueue(
      store,
      { windowMs: 1000, maxRequests: 2, strategy: RateLimitStrategy.SLIDING_WINDOW },
      {},
    );

    const r: RateLimiterQueueResult = await q.removeTokens('user-a');
    expect(store.incrementCalls).toHaveLength(1);
    expect(store.incrementCalls[0]!.key).toBe('user-a');
    expect(r.remaining).toBe(0);
  });

  it('retries when increment returns isBlocked until the window can accept', async () => {
    const store = new MockClusterLikeStore({ blockedPhases: 1, windowMs: 1000 });
    const q = new RateLimiterQueue(
      store,
      { windowMs: 1000, maxRequests: 1, strategy: RateLimitStrategy.SLIDING_WINDOW },
      {},
    );

    const p = q.removeTokens('k');
    await flushMicrotasksDeep();
    expect(store.incrementCalls.length).toBeGreaterThanOrEqual(1);
    expect(store.incrementCalls[0]!.options?.maxRequests).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasksDeep();

    const r = await p;
    expect(r.remaining).toBeDefined();
    expect(store.incrementCalls.length).toBeGreaterThanOrEqual(2);
    await store.shutdown();
  });

  it('handles multiple keys independently with cluster-like store', async () => {
    const store = new MockClusterLikeStore({ blockedPhases: 0, windowMs: 1000 });
    const q = new RateLimiterQueue(
      store,
      { windowMs: 1000, maxRequests: 2, strategy: RateLimitStrategy.SLIDING_WINDOW },
      {},
    );

    const [r1, r2] = await Promise.all([q.removeTokens('user-a'), q.removeTokens('user-b')]);

    expect(store.incrementCalls).toHaveLength(2);
    expect(store.incrementCalls[0]!.key).toBe('user-a');
    expect(store.incrementCalls[1]!.key).toBe('user-b');
    expect(r1.remaining).toBeDefined();
    expect(r2.remaining).toBeDefined();
    await store.shutdown();
  });
});
