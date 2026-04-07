import { describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../src/key-manager/KeyManager.js';
import {
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
} from '../src/middleware/merge-options.js';
import { InMemoryShield } from '../src/shield/InMemoryShield.js';
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

  it('throws when penaltyBox and keyManager are both user-supplied', () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const km = new KeyManager({ store, maxRequests: 10, windowMs: 60_000 });
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        store,
        penaltyBox: { violationsThreshold: 2, penaltyDurationMs: 60_000 },
        keyManager: km,
      }),
    ).toThrow(/penaltyBox.*keyManager/);
    void km.destroy();
    void store.shutdown();
  });

  it('allows penaltyBox with keyManager when allowPenaltyBoxWithKeyManager (Nest re-merge)', () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const km = new KeyManager({ store, maxRequests: 10, windowMs: 60_000 });
    expect(() =>
      mergeRateLimiterOptions(
        {
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          store,
          penaltyBox: { violationsThreshold: 2, penaltyDurationMs: 60_000 },
          keyManager: km,
        },
        { allowPenaltyBoxWithKeyManager: true },
      ),
    ).not.toThrow();
    void km.destroy();
    void store.shutdown();
  });

  it('warns once in non-production when inMemoryBlock wraps an existing InMemoryShield', () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const existing = new InMemoryShield(inner, {
      blockOnConsumed: 2,
      blockDurationMs: 60_000,
    });
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      store: existing,
      inMemoryBlock: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveStoreWithInMemoryShield(merged);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/double-shielding/);
    resolveStoreWithInMemoryShield(merged);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    void inner.shutdown();
  });

  it('does not warn when NODE_ENV is production (double InMemoryShield)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const existing = new InMemoryShield(inner, {
      blockOnConsumed: 2,
      blockDurationMs: 60_000,
    });
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      store: existing,
      inMemoryBlock: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveStoreWithInMemoryShield(merged);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    void inner.shutdown();
    vi.unstubAllEnvs();
  });
});
