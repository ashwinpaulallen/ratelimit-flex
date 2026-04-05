import { describe, expect, it } from 'vitest';
import { compose, MemoryStore, RateLimitStrategy } from '../../src/index.js';

describe('compose API type inference (exercised at compile time)', () => {
  it('compose.windows and withBurst accept required config fields', () => {
    const multi = compose.windows(
      { windowMs: 1000, maxRequests: 10 },
      { windowMs: 60_000, maxRequests: 100 },
    );
    expect(multi).toBeDefined();

    const burst = compose.withBurst({
      steady: { windowMs: 1000, maxRequests: 2 },
      burst: { windowMs: 10_000, maxRequests: 5 },
    });
    expect(burst).toBeDefined();
  });

  it('compose.layer requires label and store', () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 1,
    });
    const layer = compose.layer('slot', store);
    expect(layer.label).toBe('slot');
    expect(layer.store).toBe(store);
  });

  it('compose.all / overflow / firstAvailable are callable', () => {
    const a = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 1,
    });
    const b = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 2000,
      maxRequests: 2,
    });
    expect(compose.all(compose.layer('a', a), compose.layer('b', b))).toBeDefined();
    expect(compose.overflow(compose.layer('a', a), compose.layer('b', b))).toBeDefined();
    expect(compose.firstAvailable(compose.layer('a', a), compose.layer('b', b))).toBeDefined();
  });
});
