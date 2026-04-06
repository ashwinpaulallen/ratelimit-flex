import { describe, expect, it } from 'vitest';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import { RedisStore } from '../../src/stores/redis-store.js';
import type { RedisLikeClient } from '../../src/stores/redis-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { nestAuthPreset, nestRedisPreset, nestSingleInstancePreset } from '../../src/nestjs/presets.js';

/** Minimal stub so {@link RedisStore} can be constructed without a real Redis server. */
function createStubRedisClient(): RedisLikeClient {
  return {
    get: async () => null,
    set: async () => 'OK',
    eval: async () => [0, 0, Date.now()],
  };
}

describe('NestJS presets', () => {
  it('nestSingleInstancePreset returns options mergeable by mergeRateLimiterOptions', () => {
    const preset = nestSingleInstancePreset();
    expect(() => mergeRateLimiterOptions({ ...preset, store: undefined })).not.toThrow();
    const merged = mergeRateLimiterOptions({ ...preset, store: undefined });
    expect(merged.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
    expect(merged.store).toBeDefined();
  });

  it('nestSingleInstancePreset merges overrides after defaults', () => {
    const preset = nestSingleInstancePreset({ maxRequests: 200, windowMs: 30_000 });
    expect(preset.maxRequests).toBe(200);
    expect(preset.windowMs).toBe(30_000);
    expect(preset.standardHeaders).toBe('draft-6');
  });

  it('nestRedisPreset builds a RedisStore and merges overrides', () => {
    const preset = nestRedisPreset(
      { client: createStubRedisClient() },
      { maxRequests: 50, windowMs: 120_000 },
    );
    expect(preset.store).toBeInstanceOf(RedisStore);
    expect(preset.maxRequests).toBe(50);
    expect(preset.windowMs).toBe(120_000);
    expect(() => mergeRateLimiterOptions({ ...preset })).not.toThrow();
  });

  it('nestAuthPreset builds a fixed-window RedisStore', () => {
    const preset = nestAuthPreset({ client: createStubRedisClient() });
    expect(preset.store).toBeInstanceOf(RedisStore);
    expect(preset.strategy).toBe(RateLimitStrategy.FIXED_WINDOW);
    expect(preset.maxRequests).toBe(5);
    expect(() => mergeRateLimiterOptions({ ...preset })).not.toThrow();
  });

  it('Redis presets respect overrides.store when provided', () => {
    const custom = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: createStubRedisClient(),
    });
    const preset = nestRedisPreset({ client: createStubRedisClient() }, { store: custom });
    expect(preset.store).toBe(custom);
  });
});
