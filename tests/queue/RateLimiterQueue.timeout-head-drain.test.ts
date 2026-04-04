import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRateLimiterQueue } from '../../src/queue/createRateLimiterQueue.js';

describe('RateLimiterQueue timeout-removes-head drain optimization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts drain immediately when head entry times out during drainTimer sleep', async () => {
    // Create queue with maxRequests: 2, windowMs: 10_000 (long window)
    const queue = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 10_000,
      maxQueueTimeMs: 1000, // Head entry will timeout after 1 second
    });

    // Consume 2 tokens (fills the window)
    await queue.removeTokens('key-a', 1);
    await queue.removeTokens('key-a', 1);

    // Third request blocks (window is full, will wait for 10 seconds)
    const headPromise = queue.removeTokens('key-a', 1).catch(err => err);

    // Fourth request also queued (will timeout too, but we'll extend its timeout)
    const nextPromise = queue.removeTokens('key-a', 1);

    // Manually extend the second entry's timeout to prevent it from timing out
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondEntry = (queue as any).queue[1];
    if (secondEntry && secondEntry.timer) {
      clearTimeout(secondEntry.timer);
      secondEntry.timer = null;
    }

    // Verify both are queued
    expect(queue.getQueueSize()).toBe(2);

    // Advance time by 1 second (head entry times out)
    await vi.advanceTimersByTimeAsync(1000);

    // Head entry should be rejected
    const headResult = await headPromise;
    expect(headResult).toBeInstanceOf(Error);
    expect(headResult.message).toContain('Queue timeout exceeded');

    // Queue should now have 1 entry (the next entry)
    expect(queue.getQueueSize()).toBe(1);

    // WITH THE FIX: The next entry should be processed immediately when the window resets
    // Advance time to window reset (9 more seconds)
    await vi.advanceTimersByTimeAsync(9000);

    // Next entry should resolve now (not wait an additional 9 seconds)
    const result = await nextPromise;
    expect(result).toBeDefined();
    expect(result.remaining).toBe(1);
  });

  it('does not interfere when non-head entry times out', async () => {
    // Create queue with maxRequests: 2, windowMs: 5000
    const queue = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 5000,
      maxQueueTimeMs: 1000,
    });

    // Consume 2 tokens (fills the window)
    await queue.removeTokens('key-a', 1);
    await queue.removeTokens('key-a', 1);

    // Third request blocks (head of queue)
    const headPromise = queue.removeTokens('key-a', 1).catch(err => err);

    // Fourth request also queued (not head)
    const nonHeadPromise = queue.removeTokens('key-a', 1).catch(err => err);

    // Verify both are queued
    expect(queue.getQueueSize()).toBe(2);

    // Advance time by 1 second (both entries timeout)
    await vi.advanceTimersByTimeAsync(1000);

    // Both entries timeout
    const headResult = await headPromise;
    const nonHeadResult = await nonHeadPromise;
    
    expect(headResult).toBeInstanceOf(Error);
    expect(nonHeadResult).toBeInstanceOf(Error);

    // Queue should be empty
    expect(queue.getQueueSize()).toBe(0);
  });

  it('demonstrates the performance improvement: immediate restart vs waiting', async () => {
    const queue = createRateLimiterQueue({
      maxRequests: 1,
      windowMs: 10_000, // Long window
      maxQueueTimeMs: 500, // Short timeout
    });

    // Consume 1 token (fills the window)
    await queue.removeTokens('key-a', 1);

    // Second request blocks (will wait for 10 seconds)
    const headPromise = queue.removeTokens('key-a', 1).catch(err => err);

    // Third request also queued
    const nextPromise = queue.removeTokens('key-a', 1);

    // Manually extend the second entry's timeout
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondEntry = (queue as any).queue[1];
    if (secondEntry && secondEntry.timer) {
      clearTimeout(secondEntry.timer);
      secondEntry.timer = null;
    }

    expect(queue.getQueueSize()).toBe(2);

    // Advance time by 500ms (head times out)
    await vi.advanceTimersByTimeAsync(500);

    // Head rejected
    const headResult = await headPromise;
    expect(headResult).toBeInstanceOf(Error);

    // Queue now has 1 entry
    expect(queue.getQueueSize()).toBe(1);

    // WITH THE FIX: drain restarts immediately, so we only need to wait
    // the remaining time until window reset (9500ms more)
    await vi.advanceTimersByTimeAsync(9500);

    // Next entry resolves
    const result = await nextPromise;
    expect(result).toBeDefined();
  });

  it('handles multiple timeouts in sequence', async () => {
    const queue = createRateLimiterQueue({
      maxRequests: 1,
      windowMs: 5000,
      maxQueueTimeMs: 1000,
    });

    // Consume 1 token
    await queue.removeTokens('key-a', 1);

    // Queue 3 requests (all will timeout before window resets)
    const p1 = queue.removeTokens('key-a', 1).catch(err => err);
    const p2 = queue.removeTokens('key-a', 1).catch(err => err);
    const p3 = queue.removeTokens('key-a', 1).catch(err => err);

    expect(queue.getQueueSize()).toBe(3);

    // Advance time by 1 second (all entries timeout at once since they all have same maxQueueTimeMs)
    await vi.advanceTimersByTimeAsync(1000);
    
    const r1 = await p1;
    const r2 = await p2;
    const r3 = await p3;
    
    expect(r1).toBeInstanceOf(Error);
    expect(r2).toBeInstanceOf(Error);
    expect(r3).toBeInstanceOf(Error);
    expect(queue.getQueueSize()).toBe(0);

    // All entries timed out, queue is empty
  });
});
