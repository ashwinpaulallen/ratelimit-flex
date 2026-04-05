import { describe, expect, it } from 'vitest';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { compose } from '../../src/composition/compose.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitStore } from '../../src/types/index.js';

function sliding(max: number, windowMs = 60_000) {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs,
    maxRequests: max,
  });
}

describe('compose', () => {
  it('layer() creates correct CompositionLayer shape', () => {
    const store = sliding(10);
    const layer = compose.layer('my-layer', store, {
      keyTransform: (k) => `p:${k}`,
      maxRequests: 5,
    });
    expect(layer).toEqual({
      label: 'my-layer',
      store,
      keyTransform: expect.any(Function),
      maxRequests: 5,
    });
    expect(layer.keyTransform?.('x')).toBe('p:x');
  });

  it('all() creates ComposedStore with mode all', () => {
    const c = compose.all(compose.layer('a', sliding(1)), compose.layer('b', sliding(2)));
    expect(c).toBeInstanceOf(ComposedStore);
    expect(c.mode).toBe('all');
  });

  it('overflow() creates ComposedStore with mode overflow and exactly 2 layers', () => {
    const c = compose.overflow(compose.layer('primary', sliding(1)), compose.layer('burst', sliding(2)));
    expect(c.mode).toBe('overflow');
    expect(c.layers).toHaveLength(2);
  });

  it('firstAvailable() creates ComposedStore with mode first-available', () => {
    const c = compose.firstAvailable(compose.layer('a', sliding(1)), compose.layer('b', sliding(2)));
    expect(c.mode).toBe('first-available');
  });

  it('race() creates ComposedStore with mode race', () => {
    const c = compose.race(compose.layer('a', sliding(1)), compose.layer('b', sliding(2)));
    expect(c.mode).toBe('race');
  });

  it('windows() creates index-labeled MemoryStore layers (limit-0, limit-1, …)', async () => {
    const c = compose.windows(
      { windowMs: 1000, maxRequests: 10 },
      { windowMs: 60_000, maxRequests: 100 },
      { windowMs: 3_600_000, maxRequests: 1000 },
    );
    expect(c.mode).toBe('all');
    const r = await c.increment('k');
    expect(r.layers['limit-0']).toBeDefined();
    expect(r.layers['limit-1']).toBeDefined();
    expect(r.layers['limit-2']).toBeDefined();
    await c.shutdown();
  });

  it('windows() labels by slot index even for odd windowMs', async () => {
    const c = compose.windows({ windowMs: 500, maxRequests: 3 });
    const r = await c.increment('k');
    expect(r.layers['limit-0']).toBeDefined();
    await c.shutdown();
  });

  it('withBurst() creates overflow with steady and burst MemoryStores when stores omitted', async () => {
    const c = compose.withBurst({
      steady: { windowMs: 1000, maxRequests: 5 },
      burst: { windowMs: 60_000, maxRequests: 20 },
    });
    expect(c.mode).toBe('overflow');
    const r = await c.increment('user');
    expect(r.decidingLayer).toBe('steady');
    expect(r.layers.steady.consulted).toBe(true);
    expect(r.layers.burst.consulted).toBe(false);
    await c.shutdown();
  });

  it('withBurst() uses provided stores when passed', () => {
    const s = sliding(2);
    const b = sliding(20);
    const c = compose.withBurst({
      steady: { windowMs: 1000, maxRequests: 5, store: s },
      burst: { windowMs: 60_000, maxRequests: 20, store: b },
    });
    expect(c.mode).toBe('overflow');
  });

  it('nested composition: ComposedStore as a layer store', async () => {
    const inner = compose.overflow(compose.layer('p', sliding(1)), compose.layer('b', sliding(5)));
    const flat = sliding(20);
    const outer = compose.all(compose.layer('nested-overflow', inner), compose.layer('flat', flat));
    expect(outer.mode).toBe('all');
    const store: RateLimitStore = inner;
    expect(typeof store.increment).toBe('function');
    const r = await outer.increment('client');
    expect(r.isBlocked).toBe(false);
    await outer.shutdown();
  });
});
