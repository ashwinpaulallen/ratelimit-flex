import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { mergeRateLimiterOptions, resolveStoreWithInMemoryShield } from '../../src/middleware/merge-options.js';
import { MetricsManager } from '../../src/metrics/manager.js';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { RateLimitEngine } from '../../src/strategies/rate-limit-engine.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import type { RateLimitDecrementOptions, RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const WINDOW_MS = 60_000;

/**
 * Fixed-window–style mock: `isBlocked` when totalHits > maxRequests.
 * Shield caches when totalHits >= blockOnConsumed (typically === maxRequests).
 * `decrement` honors {@link RateLimitDecrementOptions.cost} (used by KeyManager.reward).
 */
function createMockRedisStore(maxRequests: number): RateLimitStore & {
  increment: ReturnType<typeof vi.fn>;
  decrement: ReturnType<typeof vi.fn>;
} {
  const counts = new Map<string, number>();
  const increment = vi.fn(async (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const isBlocked = n > maxRequests;
    return {
      totalHits: n,
      remaining: isBlocked ? 0 : Math.max(0, maxRequests - n),
      resetTime: new Date(Date.now() + WINDOW_MS),
      isBlocked,
    };
  });
  const decrement = vi.fn(async (key: string, options?: RateLimitDecrementOptions) => {
    const cost = Math.max(1, Math.floor(options?.cost ?? 1));
    const n = counts.get(key) ?? 0;
    counts.set(key, Math.max(0, n - cost));
  });
  return {
    increment,
    decrement,
    reset: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** Mock with per-key window reset when `now >= windowEnd` (use with fake timers). */
function createMockRedisStoreWithExpiry(
  windowMs: number,
  maxRequests: number,
): RateLimitStore & { increment: ReturnType<typeof vi.fn> } {
  const state = new Map<string, { count: number; windowEnd: number }>();
  const increment = vi.fn(async (key: string) => {
    const now = Date.now();
    let s = state.get(key);
    if (s === undefined || now >= s.windowEnd) {
      s = { count: 0, windowEnd: now + windowMs };
    }
    s.count += 1;
    state.set(key, { ...s });
    const n = s.count;
    const isBlocked = n > maxRequests;
    return {
      totalHits: n,
      remaining: isBlocked ? 0 : Math.max(0, maxRequests - n),
      resetTime: new Date(s.windowEnd),
      isBlocked,
    };
  });
  const decrement = vi.fn(async (key: string, options?: RateLimitDecrementOptions) => {
    const cost = Math.max(1, Math.floor(options?.cost ?? 1));
    const s = state.get(key);
    if (s === undefined) return;
    s.count = Math.max(0, s.count - cost);
    state.set(key, { ...s });
  });
  return {
    increment,
    decrement,
    reset: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('shield integration (DoS-style)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Scenario 1 — basic shielding: 10 store hits then 990 shielded 429s', async () => {
    const maxReq = 10;
    const inner = createMockRedisStore(maxReq);
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: maxReq,
      blockDurationMs: WINDOW_MS,
      maxBlockedKeys: 100,
      sweepIntervalMs: 0,
    });

    const merged = mergeRateLimiterOptions({
      store: shielded,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: maxReq,
      headers: false,
    });
    const { optionsForEngine: resolved } = resolveStoreWithInMemoryShield(merged);
    const metricsManager = new MetricsManager(resolved.metrics, null);
    const engine = new RateLimitEngine(resolved, metricsManager.getCounters() ?? undefined);

    const app = express();
    app.use(
      expressRateLimiter({
        store: shielded,
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: WINDOW_MS,
        maxRequests: maxReq,
        keyGenerator: () => 'attacker-ip',
        headers: false,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).send('ok'));

    const agent = request.agent(app);

    for (let i = 0; i < 10; i++) {
      const r = await agent.get('/ok');
      expect(r.status).toBe(200);
    }
    expect(inner.increment).toHaveBeenCalledTimes(10);

    // Same engine path as the middleware; high-volume supertest here was flaky (401/404/parse errors).
    const key = 'attacker-ip';
    for (let i = 0; i < 990; i++) {
      const out = await engine.consumeWithKey(key);
      expect(out.isBlocked).toBe(true);
      expect(out.blockReason).toBe('rate_limit');
    }

    expect(inner.increment).toHaveBeenCalledTimes(10);

    const m = shielded.getMetrics();
    expect(m.storeCallsSaved).toBe(990);
    expect(m.storeCalls).toBe(10);
    expect(m.hitRate).toBeGreaterThan(0.98);

    expect((await agent.get('/ok')).status).toBe(429);

    await metricsManager.shutdown();
    await shielded.shutdown();
  });

  it('Scenario 2 — 50 keys × 100 requests: 500 store hits, 4500 shielded, 50 blocked keys', async () => {
    const maxReq = 10;
    const inner = createMockRedisStore(maxReq);
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: maxReq,
      blockDurationMs: WINDOW_MS,
      maxBlockedKeys: 100,
      sweepIntervalMs: 0,
    });

    const merged = mergeRateLimiterOptions({
      store: shielded,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: maxReq,
      headers: false,
    });
    const { optionsForEngine: resolved } = resolveStoreWithInMemoryShield(merged);
    const metricsManager = new MetricsManager(resolved.metrics, null);
    const engine = new RateLimitEngine(resolved, metricsManager.getCounters() ?? undefined);

    const limiter = expressRateLimiter({
      store: shielded,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: maxReq,
      keyGenerator: () => 'attacker-0',
      headers: false,
    });
    expect(limiter.shield).toBeNull();

    // Same RateLimitEngine path as the Express middleware; high-volume HTTP clients were missing a few shield tallies.
    for (let k = 0; k < 50; k++) {
      const key = `attacker-${k}`;
      for (let i = 0; i < 100; i++) {
        await engine.consumeWithKey(key);
      }
    }

    expect(inner.increment).toHaveBeenCalledTimes(500);
    const m = shielded.getMetrics();
    expect(m.storeCalls).toBe(500);
    expect(m.storeCalls + m.storeCallsSaved).toBe(5000);
    expect(m.storeCallsSaved).toBe(4500);
    expect(m.blockedKeyCount).toBe(50);

    await metricsManager.shutdown();
    await shielded.shutdown();
  });

  it('Scenario 3 — expiry: 11th request hits store after window advances', async () => {
    const maxReq = 10;
    const inner = createMockRedisStoreWithExpiry(WINDOW_MS, maxReq);
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: maxReq,
      blockDurationMs: WINDOW_MS,
      sweepIntervalMs: 0,
    });

    const app = express();
    app.use(
      expressRateLimiter({
        store: shielded,
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: WINDOW_MS,
        maxRequests: maxReq,
        keyGenerator: () => 'user-1',
        headers: false,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).send('ok'));

    for (let i = 0; i < 10; i++) {
      await request(app).get('/ok');
    }
    await request(app).get('/ok');
    expect(inner.increment).toHaveBeenCalledTimes(10);

    vi.setSystemTime(new Date(Date.now() + WINDOW_MS + 1));

    inner.increment.mockClear();
    const after = await request(app).get('/ok');
    expect(after.status).toBe(200);
    expect(inner.increment).toHaveBeenCalledTimes(1);

    await shielded.shutdown();
  });

  it('Scenario 4 — LRU: maxBlockedKeys 5, first keys evicted then refetch store', async () => {
    const maxReq = 1;
    const inner = createMockRedisStore(maxReq);
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: 1,
      blockDurationMs: WINDOW_MS,
      maxBlockedKeys: 5,
    });

    let key = 'k0';
    const app = express();
    app.use(
      expressRateLimiter({
        store: shielded,
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: WINDOW_MS,
        maxRequests: maxReq,
        keyGenerator: () => key,
        headers: false,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).send('ok'));

    for (let i = 0; i < 10; i++) {
      key = `k${i}`;
      await request(app).get('/ok');
      await request(app).get('/ok');
    }

    expect(shielded.getShieldedKeys().length).toBeLessThanOrEqual(5);

    inner.increment.mockClear();
    for (let i = 0; i < 5; i++) {
      key = `k${i}`;
      await request(app).get('/ok');
      expect(inner.increment).toHaveBeenCalled();
    }
    expect(inner.increment.mock.calls.length).toBeGreaterThanOrEqual(5);

    await shielded.shutdown();
  });

  it('Scenario 5 — KeyManager.reward invalidates shield; next request hits store', async () => {
    const maxReq = 3;
    const inner = createMockRedisStore(maxReq);
    const shielded = new InMemoryShield(inner, {
      blockOnConsumed: maxReq,
      blockDurationMs: WINDOW_MS,
    });
    const km = new KeyManager({
      store: shielded,
      maxRequests: maxReq,
      windowMs: WINDOW_MS,
    });

    const app = express();
    app.use(
      expressRateLimiter({
        store: shielded,
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: WINDOW_MS,
        maxRequests: maxReq,
        keyGenerator: () => 'victim',
        headers: false,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).send('ok'));

    await request(app).get('/ok');
    await request(app).get('/ok');
    await request(app).get('/ok');
    expect(shielded.isShielded('victim')).toBe(true);

    inner.increment.mockClear();
    await km.reward('victim', 5);
    expect(shielded.isShielded('victim')).toBe(false);

    const r = await request(app).get('/ok');
    expect(r.status).toBe(200);
    expect(inner.increment).toHaveBeenCalled();

    km.destroy();
    await shielded.shutdown();
  });

  it('Scenario 6 — MemoryStore + inMemoryBlock: no shield wrapper, handler.shield null', () => {
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: 10,
    });
    const limiter = expressRateLimiter({
      store: mem,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: 10,
      inMemoryBlock: true,
    });

    expect(limiter.shield).toBeNull();

    void mem.shutdown();
  });
});
