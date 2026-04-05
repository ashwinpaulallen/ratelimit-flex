import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const stores: MemoryStore[] = [];
function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const store = new MemoryStore(options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

// Retry wrapper for flaky supertest HTTP parse errors
async function retryRequest<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  throw lastError;
}

describe('metrics integration (Express)', () => {
  it('aggregates totals and latency after requests; block and hot keys behave', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      keyGenerator: () => 'test-ip-1',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
      metrics: {
        enabled: true,
        intervalMs: 1000,
        topKSize: 10,
      },
    });

    const app = express();
    app.use(limiter);
    app.get('/ok', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    for (let i = 0; i < 50; i++) {
      await retryRequest(() => request(app).get('/ok').expect(200));
    }

    await new Promise((r) => setTimeout(r, 1100));

    const snap = limiter.getMetricsSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.totals.requests).toBe(50);
    expect(snap!.latency.p50).toBeGreaterThan(0);
    expect(snap!.latency.p50).toBeLessThan(1000);
    expect(snap!.latency.p99).toBeLessThan(1000);

    const br = snap!.blockReasons;
    expect(br.rateLimit + br.blocklist + br.penalty + br.serviceUnavailable).toBe(snap!.totals.blocked);

    for (let i = 0; i < 120; i++) {
      await retryRequest(() => request(app).get('/ok'));
    }

    await new Promise((r) => setTimeout(r, 1100));

    const snap2 = limiter.getMetricsSnapshot();
    expect(snap2!.totals.blocked).toBeGreaterThan(0);
    expect(snap2!.blockReasons.rateLimit).toBeGreaterThan(0);

    const hot = snap2!.hotKeys.find((h) => h.key === 'test-ip-1');
    expect(hot).toBeDefined();
    expect(hot!.hits).toBeGreaterThan(0);
    expect(hot!.blocked).toBeGreaterThan(0);
    expect(hot!.blocked).toBeLessThanOrEqual(hot!.hits);

    await limiter.shutdownMetrics();
    vi.restoreAllMocks();
  }, 45_000);
});
