import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RateLimiterQueue,
  RateLimiterQueueError,
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
 * Mock store that simulates the TOKEN_BUCKET stale-head bug scenario:
 * - First increment returns blocked
 * - During the await, the entry times out and is removed from the queue
 * - When increment resolves, queue[0] !== entry (stale head)
 * - The undo should NOT decrement because the blocked increment never consumed tokens
 */
class TokenBucketStaleHeadStore implements RateLimitStore {
  incrementCalls: Array<{ key: string; options?: RateLimitIncrementOptions }> = [];
  decrementCalls: Array<{ key: string; options?: RateLimitDecrementOptions }> = [];

  private bucketTokens = 0;
  private readonly bucketSize: number;

  constructor(bucketSize: number) {
    this.bucketSize = bucketSize;
    this.bucketTokens = 0; // Start empty so first increment is blocked
  }

  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    this.incrementCalls.push({ key, options });
    const cost = options?.cost ?? 1;

    if (this.bucketTokens < cost) {
      // Blocked — bucket doesn't have enough tokens
      return {
        totalHits: this.bucketSize - this.bucketTokens,
        remaining: this.bucketTokens,
        isBlocked: true,
        resetTime: new Date(Date.now() + 1000),
      };
    }

    // Success — consume tokens
    this.bucketTokens -= cost;
    return {
      totalHits: this.bucketSize - this.bucketTokens,
      remaining: this.bucketTokens,
      isBlocked: false,
      resetTime: new Date(Date.now() + 1000),
    };
  }

  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    this.decrementCalls.push({ key, options });
    const cost = options?.cost ?? 1;
    // Token bucket decrement adds tokens back (capped at bucketSize)
    this.bucketTokens = Math.min(this.bucketTokens + cost, this.bucketSize);
  }

  async reset(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  getTokens(): number {
    return this.bucketTokens;
  }
}

describe('RateLimiterQueue TOKEN_BUCKET stale-head bug regression', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does NOT decrement bucket when stale-head increment was blocked', async () => {
    const store = new TokenBucketStaleHeadStore(10);
    const q = new RateLimiterQueue(
      store,
      {
        windowMs: 1000,
        maxRequests: 10,
        strategy: RateLimitStrategy.TOKEN_BUCKET,
      },
      {
        maxQueueSize: 10,
        maxQueueTimeMs: 50, // Short timeout to trigger stale-head
      },
    );

    // Queue a request — bucket is empty, so increment will be blocked
    const p = q.removeTokens('user-a', 5).catch((err) => err);

    // Flush microtasks so the increment starts
    await flushMicrotasksDeep();

    // Verify increment was called
    expect(store.incrementCalls).toHaveLength(1);
    expect(store.incrementCalls[0]!.options?.cost).toBe(5);

    // Advance time past maxQueueTimeMs to trigger timeout and remove entry from queue
    await vi.advanceTimersByTimeAsync(60);
    await flushMicrotasksDeep();

    // The promise should reject with timeout error
    const err = await p;
    expect(err).toBeInstanceOf(RateLimiterQueueError);
    expect(err.message).toContain('Queue timeout exceeded');

    // Key assertion: decrement should NOT have been called
    // Before the fix, the stale-head path would call decrement even though
    // the increment was blocked (isBlocked: true), inflating the bucket
    expect(store.decrementCalls).toHaveLength(0);

    // Bucket should still be at 0 tokens (not inflated to 5)
    expect(store.getTokens()).toBe(0);

    await store.shutdown();
  });

  it('verifies fix prevents bucket inflation on blocked stale-head', async () => {
    // This test verifies the bug is fixed:
    // Before fix: blocked TOKEN_BUCKET increment + stale-head → decrement called → bucket inflated
    // After fix: blocked TOKEN_BUCKET increment + stale-head → no decrement → bucket unchanged

    const store = new TokenBucketStaleHeadStore(10);
    const q = new RateLimiterQueue(
      store,
      {
        windowMs: 1000,
        maxRequests: 10,
        strategy: RateLimitStrategy.TOKEN_BUCKET,
      },
      {
        maxQueueSize: 10,
        maxQueueTimeMs: 50,
      },
    );

    // Queue request — bucket empty, increment will be blocked
    const p = q.removeTokens('user-a', 5).catch((err) => err);
    await flushMicrotasksDeep();

    // Verify increment returned isBlocked: true
    expect(store.incrementCalls).toHaveLength(1);
    expect(store.getTokens()).toBe(0); // Still empty

    // Timeout fires, entry removed from queue
    await vi.advanceTimersByTimeAsync(60);
    await flushMicrotasksDeep();

    const err = await p;
    expect(err).toBeInstanceOf(RateLimiterQueueError);
    expect(err.message).toContain('Queue timeout exceeded');

    // Critical assertion: no decrement should have been called
    // (blocked TOKEN_BUCKET increments don't consume tokens, so nothing to undo)
    expect(store.decrementCalls).toHaveLength(0);
    expect(store.getTokens()).toBe(0); // Bucket not inflated

    await store.shutdown();
  });

  it('does NOT decrement when blocked path is taken (existing behavior)', async () => {
    const store = new TokenBucketStaleHeadStore(10);
    const q = new RateLimiterQueue(
      store,
      {
        windowMs: 1000,
        maxRequests: 10,
        strategy: RateLimitStrategy.TOKEN_BUCKET,
      },
      {
        maxQueueSize: 10,
      },
    );

    // Queue request — blocked because bucket is empty
    const p = q.removeTokens('user-a', 5);
    await flushMicrotasksDeep();

    expect(store.incrementCalls).toHaveLength(1);
    expect(store.getTokens()).toBe(0);

    // No timeout — entry stays in queue, blocked path is taken
    // Decrement should NOT be called for blocked TOKEN_BUCKET
    expect(store.decrementCalls).toHaveLength(0);

    // Refill bucket so queue can drain
    await store.decrement('user-a', { cost: 10 });
    expect(store.getTokens()).toBe(10);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasksDeep();

    await p;

    // Still only 1 decrement (the manual refill)
    expect(store.decrementCalls).toHaveLength(1);
    expect(store.getTokens()).toBe(5); // 10 - 5

    await store.shutdown();
  });
});
