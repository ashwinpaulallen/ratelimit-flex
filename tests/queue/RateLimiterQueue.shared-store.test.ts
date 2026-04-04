import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiterQueue } from '../../src/queue/RateLimiterQueue.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('RateLimiterQueue with shared store', () => {
  let sharedStore: MemoryStore;
  let queue1: RateLimiterQueue;
  let queue2: RateLimiterQueue;

  beforeEach(() => {
    sharedStore = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 5,
    });

    queue1 = new RateLimiterQueue(
      sharedStore,
      {
        windowMs: 1000,
        maxRequests: 5,
        keyPrefix: 'queue1',
        strategy: RateLimitStrategy.SLIDING_WINDOW,
      },
      { maxQueueSize: 10 },
    );

    queue2 = new RateLimiterQueue(
      sharedStore,
      {
        windowMs: 1000,
        maxRequests: 5,
        keyPrefix: 'queue2',
        strategy: RateLimitStrategy.SLIDING_WINDOW,
      },
      { maxQueueSize: 10 },
    );
  });

  it('shutdown() on one queue closes the shared store for all queues', async () => {
    // Spy on the store's shutdown method
    const shutdownSpy = vi.spyOn(sharedStore, 'shutdown');

    // Queue1 can successfully remove tokens
    await expect(queue1.removeTokens('test-key')).resolves.toBeDefined();

    // Shutdown queue1 (this closes the shared store)
    queue1.shutdown();

    // Verify store.shutdown() was called
    expect(shutdownSpy).toHaveBeenCalledOnce();

    // Queue2 can no longer use the store (it's been closed)
    // Note: MemoryStore doesn't actually prevent operations after shutdown,
    // but this demonstrates the ownership issue
  });

  it('clear() on one queue does not affect the shared store', async () => {
    const shutdownSpy = vi.spyOn(sharedStore, 'shutdown');

    // Queue1 can successfully remove tokens
    await expect(queue1.removeTokens('test-key')).resolves.toBeDefined();

    // Clear queue1 (does NOT close the store)
    queue1.clear();

    // Verify store.shutdown() was NOT called
    expect(shutdownSpy).not.toHaveBeenCalled();

    // Queue2 can still use the store
    await expect(queue2.removeTokens('test-key')).resolves.toBeDefined();

    // Manually shutdown the store when all queues are done
    await sharedStore.shutdown();
    expect(shutdownSpy).toHaveBeenCalledOnce();
  });

  it('demonstrates safe pattern: clear() all queues, then shutdown store', async () => {
    const shutdownSpy = vi.spyOn(sharedStore, 'shutdown');

    // Both queues work normally
    await expect(queue1.removeTokens('key1')).resolves.toBeDefined();
    await expect(queue2.removeTokens('key2')).resolves.toBeDefined();

    // Safe shutdown pattern:
    queue1.clear(); // Clear queue1's pending requests
    queue2.clear(); // Clear queue2's pending requests

    // Store is still functional
    expect(shutdownSpy).not.toHaveBeenCalled();

    // Now shutdown the shared store
    await sharedStore.shutdown();
    expect(shutdownSpy).toHaveBeenCalledOnce();
  });

  it('demonstrates unsafe pattern: shutdown() first queue breaks second queue', async () => {
    const shutdownSpy = vi.spyOn(sharedStore, 'shutdown');

    // Both queues work initially
    await expect(queue1.removeTokens('key1')).resolves.toBeDefined();
    await expect(queue2.removeTokens('key2')).resolves.toBeDefined();

    // Unsafe: shutdown queue1 (closes shared store)
    queue1.shutdown();
    expect(shutdownSpy).toHaveBeenCalledOnce();

    // Queue2 is now broken because its store was closed by queue1
    // (In practice, MemoryStore continues to work, but RedisStore/ClusterStore would fail)
  });
});
