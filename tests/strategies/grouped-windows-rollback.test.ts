import { describe, expect, it, vi } from 'vitest';

import { RateLimitEngine } from '../../src/strategies/rate-limit-engine.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitResult, RateLimitStore } from '../../src/types/index.js';

describe('RateLimitEngine grouped windows — exception rollback', () => {
  it('rolls back prior increments when a later grouped store throws', async () => {
    const first = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const throwing: RateLimitStore = {
      increment: vi.fn(async (): Promise<RateLimitResult> => {
        throw new Error('simulated store failure');
      }),
      decrement: vi.fn(async () => {
        /* noop */
      }),
      reset: vi.fn(async () => {
        /* noop */
      }),
    };
    const main = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });

    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: main,
      groupedWindowStores: [
        { label: 'a', maxRequests: 100, store: first },
        { label: 'b', maxRequests: 100, store: throwing },
      ],
    });

    await expect(engine.consumeWithKey('k', {})).rejects.toThrow('simulated store failure');

    const snap = first.getActiveKeys?.()?.get('k');
    expect(snap?.totalHits ?? 0).toBe(0);

    await first.shutdown();
    await main.shutdown();
  });
});
