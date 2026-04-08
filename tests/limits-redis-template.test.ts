import { describe, expect, it } from 'vitest';
import { compose } from '../src/composition/compose.js';
import { ComposedStore } from '../src/composition/ComposedStore.js';
import {
  limitsToComposedStoreFromRedisTemplate,
  mergeRateLimiterOptions,
} from '../src/middleware/merge-options.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RedisStore } from '../src/stores/redis-store.js';
import { RateLimitStrategy } from '../src/types/index.js';
import { createRedisEvalEmulator } from './helpers/redis-eval-emulator.js';

describe('limits + store (merge)', () => {
  it('allows limits + MemoryStore (ignored; same as no store)', () => {
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        store: mem,
        limits: [{ windowMs: 10_000, max: 2 }],
      }),
    ).not.toThrow();
    void mem.shutdown();
  });

  it('merge builds ComposedStore from Redis template (same client, distinct keys)', async () => {
    const client = createRedisEvalEmulator();
    const template = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 999,
      client,
      keyPrefix: 'rlf:test:',
    });
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      store: template,
      limits: [
        { windowMs: 10_000, max: 2 },
        { windowMs: 60_000, max: 5 },
      ],
    });
    expect(merged.store).toBeDefined();
    const key = 'u1';
    const r1 = await merged.store.increment(key);
    expect(r1.isBlocked).toBe(false);
    const r2 = await merged.store.increment(key);
    expect(r2.isBlocked).toBe(false);
    const r3 = await merged.store.increment(key);
    expect(r3.isBlocked).toBe(true);
    await merged.store.shutdown();
    await template.shutdown();
  });

  it('limitsToComposedStoreFromRedisTemplate matches compose.windows(redis, ...)', () => {
    const client = createRedisEvalEmulator();
    const template = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      keyPrefix: 'rlf:cmp:',
    });
    const a = limitsToComposedStoreFromRedisTemplate(
      template,
      RateLimitStrategy.SLIDING_WINDOW,
      [
        { windowMs: 1000, maxRequests: 10 },
        { windowMs: 2000, maxRequests: 20 },
      ],
    );
    const b = compose.windows(template, { windowMs: 1000, maxRequests: 10 }, { windowMs: 2000, maxRequests: 20 });
    expect(a).toBeInstanceOf(ComposedStore);
    expect(b).toBeInstanceOf(ComposedStore);
    void a.shutdown();
    void b.shutdown();
    void template.shutdown();
  });

  it('allows Redis template with resilience (cloned per slot)', () => {
    const client = createRedisEvalEmulator();
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const insurance = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client,
      keyPrefix: 'rlf:ins:',
      resilience: {
        insuranceLimiter: {
          store: mem,
        },
      },
    });
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        store: insurance,
        limits: [
          { windowMs: 60_000, max: 5 },
          { windowMs: 120_000, max: 20 },
        ],
      }),
    ).not.toThrow();
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      store: insurance,
      limits: [
        { windowMs: 60_000, max: 5 },
        { windowMs: 120_000, max: 20 },
      ],
    });
    expect(merged.store).toBeDefined();
    void merged.store.shutdown();
    void insurance.shutdown();
    void mem.shutdown();
  });
});
