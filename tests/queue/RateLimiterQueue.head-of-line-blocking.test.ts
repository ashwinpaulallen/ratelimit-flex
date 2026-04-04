import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRateLimiterQueue } from '../../src/queue/createRateLimiterQueue.js';
import { RateLimiterQueue } from '../../src/queue/RateLimiterQueue.js';

describe('RateLimiterQueue head-of-line blocking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('demonstrates head-of-line blocking: key B waits for key A even when B has capacity', async () => {
    // Single queue with maxRequests: 2, windowMs: 1000
    const queue = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 1000,
    });

    // Key A: consume 2 tokens (fills the window)
    await queue.removeTokens('key-a', 1);
    await queue.removeTokens('key-a', 1);

    // Key A: third request blocks (window is full)
    const keyAPromise = queue.removeTokens('key-a', 1);

    // Key B: first request (should have capacity, but waits behind key A)
    const keyBPromise = queue.removeTokens('key-b', 1);

    // Verify both are queued
    expect(queue.getQueueSize()).toBe(2);

    // Advance time to reset the window
    await vi.advanceTimersByTimeAsync(1000);

    // Key A resolves first (FIFO)
    const resultA = await keyAPromise;
    expect(resultA).toBeDefined();

    // Key B resolves second (even though it had capacity)
    const resultB = await keyBPromise;
    expect(resultB).toBeDefined();

    // This demonstrates head-of-line blocking: key B waited for key A
    // even though key B had never been used before and had full capacity
  });

  it('demonstrates solution: separate queues per key for independent processing', async () => {
    // Create separate queues for each key
    const queueA = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 1000,
    });

    const queueB = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 1000,
    });

    // Key A: consume 2 tokens (fills the window)
    await queueA.removeTokens('key-a', 1);
    await queueA.removeTokens('key-a', 1);

    // Key A: third request blocks (window is full)
    const keyAPromise = queueA.removeTokens('key-a', 1);

    // Key B: first request (has capacity, resolves immediately)
    const keyBPromise = queueB.removeTokens('key-b', 1);

    // Key B resolves immediately (not blocked by key A)
    const resultB = await keyBPromise;
    expect(resultB).toBeDefined();
    expect(resultB.remaining).toBe(1); // 1 token remaining

    // Key A is still queued
    expect(queueA.getQueueSize()).toBe(1);

    // Advance time to reset key A's window
    await vi.advanceTimersByTimeAsync(1000);

    // Key A resolves
    const resultA = await keyAPromise;
    expect(resultA).toBeDefined();

    // This demonstrates the solution: separate queues allow independent processing
  });

  it('demonstrates typical use case: single key per queue (no head-of-line blocking)', async () => {
    // Typical outbound API throttler: one queue, one key
    const githubQueue = createRateLimiterQueue({
      maxRequests: 3,
      windowMs: 1000,
    });

    // All requests use the same key
    await githubQueue.removeTokens('github-api', 1);
    await githubQueue.removeTokens('github-api', 1);
    await githubQueue.removeTokens('github-api', 1);

    // Fourth request blocks (window is full)
    const blockedPromise = githubQueue.removeTokens('github-api', 1);

    // Verify it's queued
    expect(githubQueue.getQueueSize()).toBe(1);

    // Advance time to reset the window
    await vi.advanceTimersByTimeAsync(1000);

    // Request resolves
    const result = await blockedPromise;
    expect(result).toBeDefined();

    // No head-of-line blocking issue because all requests use the same key
  });

  it('demonstrates Map-based queue-per-key pattern', async () => {
    const queues = new Map<string, RateLimiterQueue>();

    function getQueue(key: string): RateLimiterQueue {
      if (!queues.has(key)) {
        queues.set(
          key,
          createRateLimiterQueue({
            maxRequests: 2,
            windowMs: 1000,
          }),
        );
      }
      return queues.get(key)!;
    }

    // User alice: consume 2 tokens (fills the window)
    await getQueue('alice').removeTokens('user:alice', 1);
    await getQueue('alice').removeTokens('user:alice', 1);

    // User alice: third request blocks
    const alicePromise = getQueue('alice').removeTokens('user:alice', 1);

    // User bob: first request (independent queue, resolves immediately)
    const bobResult = await getQueue('bob').removeTokens('user:bob', 1);
    expect(bobResult).toBeDefined();
    expect(bobResult.remaining).toBe(1);

    // Alice is still queued
    expect(getQueue('alice').getQueueSize()).toBe(1);

    // Advance time
    await vi.advanceTimersByTimeAsync(1000);

    // Alice resolves
    const aliceResult = await alicePromise;
    expect(aliceResult).toBeDefined();

    // This demonstrates the Map pattern for per-key queues
  });
});
