import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { fingerprintRouteEngineOptions } from '../../src/nestjs/route-engine-fingerprint.js';
import type { RateLimitOptions } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('fingerprintRouteEngineOptions', () => {
  function slidingStore(max: number) {
    return new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: max,
    });
  }

  it('differs when maxRequests changes', () => {
    const store = slidingStore(100);
    const a: RateLimitOptions = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      store,
    };
    const b: RateLimitOptions = { ...a, maxRequests: 5 };
    expect(fingerprintRouteEngineOptions(a)).not.toBe(fingerprintRouteEngineOptions(b));
    void store.shutdown();
  });

  it('is stable for identical option shapes', () => {
    const store = slidingStore(10);
    const a: RateLimitOptions = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
      store,
    };
    expect(fingerprintRouteEngineOptions(a)).toBe(fingerprintRouteEngineOptions({ ...a }));
    void store.shutdown();
  });

  it('differs when store instance changes', () => {
    const s1 = slidingStore(10);
    const s2 = slidingStore(10);
    const base = {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    } as const;
    const a: RateLimitOptions = { ...base, store: s1 };
    const b: RateLimitOptions = { ...base, store: s2 };
    expect(fingerprintRouteEngineOptions(a)).not.toBe(fingerprintRouteEngineOptions(b));
    void s1.shutdown();
    void s2.shutdown();
  });
});
