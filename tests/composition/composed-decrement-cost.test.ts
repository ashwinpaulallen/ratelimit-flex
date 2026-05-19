import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { matchingDecrementOptions } from '../../src/strategies/rate-limit-engine.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const stores: MemoryStore[] = [];

function track(ms: MemoryStore): MemoryStore {
  stores.push(ms);
  return ms;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

describe('ComposedStore — decrement cost parity with increment', () => {
  it('mode all: decrement forwards weighted cost to every consulted layer', async () => {
    const a = track(
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
    );
    const b = track(
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
    );

    const spyA = vi.spyOn(a, 'decrement');
    const spyB = vi.spyOn(b, 'decrement');

    const c = new ComposedStore({
      mode: 'all',
      rollbackOnBlock: true,
      layers: [
        { label: 'L0', store: a, maxRequests: 100 },
        { label: 'L1', store: b, maxRequests: 100 },
      ],
    });

    await c.increment('k', { cost: 8 });
    const dec = matchingDecrementOptions({ cost: 8 });
    await c.decrement('k', dec);

    expect(spyA).toHaveBeenCalledWith('k', dec);
    expect(spyB).toHaveBeenCalledWith('k', dec);

    await c.shutdown();
  });

  it('mode overflow + burst hits: decrement uses same cost payload on routed layer key', async () => {
    const primary = track(
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 10_000,
        maxRequests: 1,
      }),
    );
    const burst = track(
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
    );

    const spyBurst = vi.spyOn(burst, 'decrement');

    const c = new ComposedStore({
      mode: 'overflow',
      layers: [
        { label: 'steady', store: primary },
        { label: 'burst', store: burst },
      ],
    });

    const r = await c.increment('k', { cost: 15 });
    expect(r.isBlocked).toBe(false);
    expect(r.mode).toBe('overflow');
    expect(r.decidingLayer).toBe('burst');

    await c.decrement('k', { cost: 15 });
    expect(spyBurst).toHaveBeenCalledTimes(1);
    const burstSk = spyBurst.mock.calls[0]![0];
    expect(typeof burstSk).toBe('string');
    expect(spyBurst.mock.calls[0]![1]).toMatchObject({ cost: 15 });

    await c.shutdown();
  });
});
