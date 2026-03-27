import { describe, expect, it } from 'vitest';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('mergeRateLimiterOptions', () => {
  it('creates MemoryStore when store is omitted', () => {
    const result = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      maxRequests: 50,
    });

    expect(result.store).toBeInstanceOf(MemoryStore);
    expect(result.maxRequests).toBe(50);
    expect(result.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
  });

  it('preserves user-provided store', () => {
    const customStore = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 1000,
      maxRequests: 10,
    });

    const result = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      store: customStore,
    });

    expect(result.store).toBe(customStore);
  });

  it('applies correct defaults for token bucket', () => {
    const result = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 5,
      interval: 1000,
      bucketSize: 20,
    });

    expect(result.strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
    expect(result.tokensPerInterval).toBe(5);
    expect(result.interval).toBe(1000);
    expect(result.bucketSize).toBe(20);
    expect(result.headers).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  it('applies correct defaults for sliding window', () => {
    const result = mergeRateLimiterOptions({});

    expect(result.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
    expect(result.windowMs).toBe(60_000);
    expect(result.maxRequests).toBe(100);
  });

  it('applies correct defaults for fixed window', () => {
    const result = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.FIXED_WINDOW,
    });

    expect(result.strategy).toBe(RateLimitStrategy.FIXED_WINDOW);
    expect(result.windowMs).toBe(60_000);
    expect(result.maxRequests).toBe(100);
  });
});
