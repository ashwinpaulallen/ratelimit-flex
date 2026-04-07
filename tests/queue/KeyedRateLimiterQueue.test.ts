import { describe, expect, it, vi } from 'vitest';
import { KeyedRateLimiterQueue } from '../../src/queue/KeyedRateLimiterQueue.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('KeyedRateLimiterQueue', () => {
  it('routes each queue key to an independent RateLimiterQueue', async () => {
    const keyed = new KeyedRateLimiterQueue({
      maxRequests: 1,
      windowMs: 60_000,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      maxKeys: 10,
    });
    await expect(keyed.removeTokens('a', 'a')).resolves.toBeDefined();
    await expect(keyed.removeTokens('b', 'b')).resolves.toBeDefined();
    keyed.shutdown();
  });

  it('evicts LRU when maxKeys exceeded and shuts down evicted queue', async () => {
    const keyed = new KeyedRateLimiterQueue({
      maxRequests: 10,
      windowMs: 60_000,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      maxKeys: 2,
    });
    const q1 = keyed.forKey('k1');
    keyed.forKey('k2');
    const spy = vi.spyOn(q1, 'shutdown');
    keyed.forKey('k3');
    expect(keyed.getKeyCount()).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    keyed.shutdown();
  });

  it('touching a key refreshes LRU order', async () => {
    const keyed = new KeyedRateLimiterQueue({
      maxRequests: 1,
      windowMs: 60_000,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      maxKeys: 2,
    });
    keyed.forKey('a');
    const qb = keyed.forKey('b');
    keyed.forKey('a');
    const spyB = vi.spyOn(qb, 'shutdown');
    keyed.forKey('c');
    expect(spyB).toHaveBeenCalledTimes(1);
    keyed.shutdown();
  });
});
