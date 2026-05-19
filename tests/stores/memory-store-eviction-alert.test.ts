import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('MemoryStore evictionVelocityAlert', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires callback once LRU eviction burst crosses minEvictions within rolling window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const cb = vi.fn();
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 99,
      maxKeys: 2,
      evictionVelocityAlert: {
        windowMs: 10_000,
        minEvictions: 3,
        cooldownMs: 0,
        callback: cb,
      },
    });
    try {
      await store.increment('a');
      await store.increment('b');
      await store.increment('c');
      await store.increment('d');
      await store.increment('e');
      expect(cb).toHaveBeenCalled();
      expect(cb.mock.calls[0]![0].evictionsInWindow).toBeGreaterThanOrEqual(3);
    } finally {
      await store.shutdown();
    }
  });
});
