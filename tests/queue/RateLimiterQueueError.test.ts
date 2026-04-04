import { describe, expect, it } from 'vitest';

import {
  RateLimiterQueue,
  RateLimiterQueueError,
} from '../../src/queue/RateLimiterQueue.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('RateLimiterQueueError codes', () => {
  it('queue_full error has correct code', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const q = new RateLimiterQueue(
      store,
      { windowMs: 60_000, maxRequests: 1 },
      { maxQueueSize: 0 }, // No queue space
    );

    try {
      await q.removeTokens('k');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimiterQueueError);
      expect((err as RateLimiterQueueError).code).toBe('queue_full');
      expect((err as RateLimiterQueueError).message).toBe('Queue is full');
    }

    await store.shutdown();
  });

  it('queue_shutdown error has correct code', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 1 }, {});

    q.shutdown();

    try {
      await q.removeTokens('k');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimiterQueueError);
      expect((err as RateLimiterQueueError).code).toBe('queue_shutdown');
      expect((err as RateLimiterQueueError).message).toBe('Queue shut down');
    }

    await store.shutdown();
  });

  it('cost_exceeds_limit error has correct code', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 10 }, {});

    try {
      await q.removeTokens('k', 20); // Cost exceeds maxRequests
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimiterQueueError);
      expect((err as RateLimiterQueueError).code).toBe('cost_exceeds_limit');
      expect((err as RateLimiterQueueError).message).toContain('exceed');
    }

    await store.shutdown();
  });

  it('queue_cleared error has correct code', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 1 }, {});

    // Consume the one allowed request
    await q.removeTokens('k');

    // Queue another (will be pending)
    const p = q.removeTokens('k').catch((err) => err);

    // Clear the queue
    q.clear();

    const err = await p;
    expect(err).toBeInstanceOf(RateLimiterQueueError);
    expect(err.code).toBe('queue_cleared');
    expect(err.message).toBe('Queue cleared');

    await store.shutdown();
  });
});
