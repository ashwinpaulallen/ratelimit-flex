import { describe, expect, it } from 'vitest';

import {
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
} from '../../src/middleware/merge-options.js';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('resolveStoreWithInMemoryShield strict double-layer', () => {
  it('throws when throwOnDoubleInMemoryShield wraps an existing InMemoryShield', async () => {
    const backing = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    try {
      const innerShield = new InMemoryShield(backing, {
        blockOnConsumed: 5,
        blockDurationMs: 60_000,
      });
      const merged = mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        store: innerShield as never,
        inMemoryBlock: true,
        throwOnDoubleInMemoryShield: true,
      });
      expect(() => resolveStoreWithInMemoryShield(merged)).toThrow(/double-shield/);
    } finally {
      await backing.shutdown();
    }
  });
});
