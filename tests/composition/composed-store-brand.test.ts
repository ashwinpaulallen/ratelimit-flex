import { describe, expect, it } from 'vitest';
import {
  COMPOSED_STORE_BRAND,
  COMPOSED_UNWRAP,
  isComposedStoreBrand,
  registerComposedStoreFacade,
  unregisterComposedStoreFacade,
} from '../../src/composition/composed-store-brand.js';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { resolveIncrementOpts } from '../../src/strategies/rate-limit-engine.js';
import type { RateLimitOptions } from '../../src/types/index.js';
import type { RateLimitStore } from '../../src/types/index.js';

function sliding(max: number) {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: max,
  });
}

describe('composed-store brand', () => {
  it('tags ComposedStore; detection does not use constructor.name', async () => {
    const c = new ComposedStore({
      mode: 'all',
      layers: [
        { label: 'a', store: sliding(10) },
        { label: 'b', store: sliding(10) },
      ],
    });
    expect(isComposedStoreBrand(c)).toBe(true);
    expect((c as Record<symbol, unknown>)[COMPOSED_STORE_BRAND]).toBe(true);
    // If we only checked constructor.name, minified bundles could mis-detect.
    expect((c as { constructor?: { name?: string } }).constructor?.name).toBe('ComposedStore');
    await c.shutdown();
  });

  it('is false for MemoryStore and plain objects', async () => {
    const m = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 5,
    });
    expect(isComposedStoreBrand(m)).toBe(false);
    expect(isComposedStoreBrand(null)).toBe(false);
    expect(isComposedStoreBrand({})).toBe(false);
    await m.shutdown();
  });

  it('subclass with minified constructor.name still detects ComposedStore; resolveIncrementOpts unchanged', async () => {
    class MinifiedNameComposed extends ComposedStore {}
    Object.defineProperty(MinifiedNameComposed, 'name', { configurable: true, value: 'n' });
    expect(MinifiedNameComposed.name).toBe('n');

    const c = new MinifiedNameComposed({
      mode: 'all',
      layers: [
        { label: 'a', store: sliding(10) },
        { label: 'b', store: sliding(10) },
      ],
    });
    expect(isComposedStoreBrand(c)).toBe(true);
    const opts = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 999,
      store: c,
    } as RateLimitOptions;
    expect(resolveIncrementOpts(opts, {})).toBeUndefined();
    await c.shutdown();
  });

  it('resolveIncrementOpts does not forward static maxRequests for ComposedStore', async () => {
    const composed = new ComposedStore({
      mode: 'all',
      layers: [
        { label: 'a', store: sliding(10) },
        { label: 'b', store: sliding(10) },
      ],
    });
    const opts = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 999,
      store: composed,
    } as RateLimitOptions;
    expect(resolveIncrementOpts(opts, {})).toBeUndefined();
    await composed.shutdown();
  });

  it('detects ComposedStore through transparent Proxy (instanceof path)', async () => {
    const c = new ComposedStore({
      mode: 'all',
      layers: [
        { label: 'a', store: sliding(5) },
        { label: 'b', store: sliding(5) },
      ],
    });
    const p = new Proxy(c, {});
    expect(isComposedStoreBrand(p)).toBe(true);
    await c.shutdown();
  });

  it('detects ComposedStore when wrapped by InMemoryShield (unwrap path)', async () => {
    const composed = new ComposedStore({
      mode: 'all',
      layers: [
        { label: 'a', store: sliding(10) },
        { label: 'b', store: sliding(10) },
      ],
    });
    const shielded = new InMemoryShield(composed, { blockOnConsumed: 5 });
    expect(isComposedStoreBrand(shielded)).toBe(true);
    const opts = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 999,
      store: shielded,
    } as RateLimitOptions;
    expect(resolveIncrementOpts(opts, {})).toBeUndefined();
    await shielded.shutdown();
  });

  it('opaque Proxy: facade registry (WeakMap) without forwarding get/has', async () => {
    const composed = new ComposedStore({
      mode: 'all',
      layers: [{ label: 'a', store: sliding(3) }],
    });
    const opaque = new Proxy(
      {},
      {
        get() {
          return undefined;
        },
        has() {
          return false;
        },
        getPrototypeOf() {
          return null;
        },
      },
    ) as object;
    expect(isComposedStoreBrand(opaque)).toBe(false);
    registerComposedStoreFacade(opaque, composed);
    expect(isComposedStoreBrand(opaque)).toBe(true);
    const opts = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 999,
      store: opaque,
    } as RateLimitOptions;
    expect(resolveIncrementOpts(opts, {})).toBeUndefined();
    unregisterComposedStoreFacade(opaque);
    expect(isComposedStoreBrand(opaque)).toBe(false);
    await composed.shutdown();
  });

  it('custom wrapper: COMPOSED_UNWRAP delegates to ComposedStore', async () => {
    const composed = new ComposedStore({
      mode: 'all',
      layers: [{ label: 'a', store: sliding(3) }],
    });
    const wrapper: RateLimitStore = {
      increment: (k, o) => composed.increment(k, o),
      decrement: (k, o) => composed.decrement(k, o),
      reset: (k) => composed.reset(k),
      shutdown: () => composed.shutdown(),
      [COMPOSED_UNWRAP]() {
        return composed;
      },
    };
    expect(isComposedStoreBrand(wrapper)).toBe(true);
    await composed.shutdown();
  });
});
