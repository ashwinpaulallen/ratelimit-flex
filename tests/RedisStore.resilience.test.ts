import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RedisStore, type RedisLikeClient } from '../src/stores/redis-store.js';
import { RateLimitStrategy } from '../src/types/index.js';

function slidingStorePair() {
  const insurance = new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
  });
  return { insurance };
}

function createEvalMock(
  behavior: () => unknown | Promise<unknown>,
): RedisLikeClient {
  return {
    get: async () => null,
    set: async () => 'OK',
    eval: async () => behavior(),
  };
}

describe('RedisStore resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('with insurance: falls back to memory when Redis eval returns no result', async () => {
    const { insurance } = slidingStorePair();
    const client = createEvalMock(() => null);
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
      },
    });

    const r = await store.increment('k1');
    expect(r.storeUnavailable).toBe(true);
    expect(r.isBlocked).toBe(false);
    expect(r.totalHits).toBe(1);
    expect(insurance.getActiveKeys().get('k1')?.totalHits).toBe(1);

    await store.shutdown();
    await insurance.shutdown();
  });

  it('opens circuit after threshold consecutive Redis failures', async () => {
    const { insurance } = slidingStorePair();
    const client = createEvalMock(() => null);
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
        circuitBreaker: { failureThreshold: 3, recoveryTimeMs: 5000 },
      },
    });

    await store.increment('a');
    await store.increment('a');
    expect(store['circuitBreaker' as keyof typeof store]).toBeDefined();
    const cb = store['circuitBreaker' as keyof typeof store] as import('../src/resilience/CircuitBreaker.js').CircuitBreaker;
    expect(cb.state).toBe('CLOSED');

    await store.increment('a');
    expect(cb.state).toBe('OPEN');

    await store.shutdown();
    await insurance.shutdown();
  });

  it('uses insurance store while circuit is OPEN without calling Redis', async () => {
    const { insurance } = slidingStorePair();
    const evalSpy = vi.fn().mockResolvedValue(null);
    const client: RedisLikeClient = {
      get: async () => null,
      set: async () => 'OK',
      eval: evalSpy,
    };

    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
        circuitBreaker: { failureThreshold: 2, recoveryTimeMs: 10_000 },
      },
    });

    await store.increment('x');
    await store.increment('x');
    evalSpy.mockClear();

    const r = await store.increment('x');
    expect(r.storeUnavailable).toBe(true);
    expect(evalSpy).not.toHaveBeenCalled();

    await store.shutdown();
    await insurance.shutdown();
  });

  it('closes circuit after Redis recovers (successful eval) and runs counter sync', async () => {
    const { insurance } = slidingStorePair();
    const onRecovery = vi.fn();
    const onCounterSync = vi.fn();
    let calls = 0;
    const client = createEvalMock(() => {
      calls++;
      if (calls <= 2) {
        return null;
      }
      return [1, 0, String(Date.now() + 60_000)];
    });

    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
        circuitBreaker: { failureThreshold: 2, recoveryTimeMs: 1000 },
        hooks: {
          onRecovery,
          onCounterSync,
        },
      },
    });

    await store.increment('u');
    await store.increment('u');
    const cb = store['circuitBreaker' as keyof typeof store] as import('../src/resilience/CircuitBreaker.js').CircuitBreaker;
    expect(cb.state).toBe('OPEN');

    await store.increment('u');
    expect(insurance.getActiveKeys().size).toBeGreaterThanOrEqual(1);

    vi.advanceTimersByTime(1000);
    const r = await store.increment('u');
    expect(r.storeUnavailable).toBeUndefined();
    expect(cb.state).toBe('CLOSED');
    expect(onRecovery).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(onCounterSync).toHaveBeenCalled();
    });

    await store.shutdown();
    await insurance.shutdown();
  });

  it('fires onFailover, onCircuitOpen, and onInsuranceHit on first Redis failure with threshold 1', async () => {
    const { insurance } = slidingStorePair();
    const onFailover = vi.fn();
    const onCircuitOpen = vi.fn();
    const onInsuranceHit = vi.fn();

    const client = createEvalMock(() => null);

    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
        circuitBreaker: { failureThreshold: 1, recoveryTimeMs: 1000 },
        hooks: {
          onFailover,
          onCircuitOpen,
          onInsuranceHit,
        },
      },
    });

    await store.increment('h');
    expect(onCircuitOpen).toHaveBeenCalledTimes(1);
    expect(onFailover).toHaveBeenCalledWith(expect.any(Error));
    expect(onInsuranceHit).toHaveBeenCalledWith('h');

    await store.shutdown();
    await insurance.shutdown();
  });

  it('without insurance: fail-open behavior unchanged when Redis returns null', async () => {
    const client = createEvalMock(() => null);
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      onRedisError: 'fail-open',
    });

    const r = await store.increment('z');
    expect(r.storeUnavailable).toBeUndefined();
    expect(r.isBlocked).toBe(false);
    await store.shutdown();
  });

  it('without insurance: fail-closed when Redis returns null', async () => {
    const client = createEvalMock(() => null);
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      onRedisError: 'fail-closed',
    });

    const r = await store.increment('z');
    expect(r.storeUnavailable).toBe(true);
    expect(r.isBlocked).toBe(true);
    await store.shutdown();
  });

  it('decrement delegates to insurance when circuit OPEN', async () => {
    const { insurance } = slidingStorePair();
    const dec = vi.spyOn(insurance, 'decrement');
    const client = createEvalMock(() => null);

    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
        circuitBreaker: { failureThreshold: 1, recoveryTimeMs: 60_000 },
      },
    });

    await store.increment('d');
    await store.decrement('d');
    expect(dec).toHaveBeenCalledWith('d', undefined);

    await store.shutdown();
    await insurance.shutdown();
  });

  it('reset delegates to insurance when circuit OPEN', async () => {
    const { insurance } = slidingStorePair();
    const rst = vi.spyOn(insurance, 'reset');
    const client = createEvalMock(() => null);

    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance },
        circuitBreaker: { failureThreshold: 1, recoveryTimeMs: 60_000 },
      },
    });

    await store.increment('r');
    await store.reset('r');
    expect(rst).toHaveBeenCalledWith('r');

    await store.shutdown();
    await insurance.shutdown();
  });

  it('syncOnRecovery: false skips onCounterSync / resetAll from sync path', async () => {
    const { insurance } = slidingStorePair();
    const onCounterSync = vi.fn();
    const resetAll = vi.spyOn(insurance, 'resetAll');

    let calls = 0;
    const client = createEvalMock(() => {
      calls++;
      if (calls <= 2) {
        return null;
      }
      return [1, 0, String(Date.now() + 60_000)];
    });

    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: {
        insuranceLimiter: { store: insurance, syncOnRecovery: false },
        circuitBreaker: { failureThreshold: 2, recoveryTimeMs: 1000 },
        hooks: { onCounterSync },
      },
    });

    await store.increment('s');
    await store.increment('s');
    vi.advanceTimersByTime(1000);
    await store.increment('s');

    expect(onCounterSync).not.toHaveBeenCalled();
    expect(resetAll).not.toHaveBeenCalled();

    await store.shutdown();
    await insurance.shutdown();
  });

  it('destroy on shutdown clears circuit breaker', async () => {
    const { insurance } = slidingStorePair();
    const client = createEvalMock(() => null);
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      resilience: { insuranceLimiter: { store: insurance } },
    });
    await store.increment('q');
    const cb = store['circuitBreaker' as keyof typeof store] as import('../src/resilience/CircuitBreaker.js').CircuitBreaker;
    await store.shutdown();
    expect(cb.state).toBe('CLOSED');
    await insurance.shutdown();
  });
});
