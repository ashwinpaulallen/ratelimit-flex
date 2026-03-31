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

describe('metrics + skip (Express)', () => {
  it('counts skipped requests when skip() is true', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      keyGenerator: () => 'k1',
      skip: () => true,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
      metrics: { enabled: true, intervalMs: 1000 },
    });

    const app = express();
    app.use(limiter);
    app.get('/x', (_req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/x').expect(200);
    await request(app).get('/x').expect(200);

    await new Promise((r) => setTimeout(r, 1100));

    const snap = limiter.getMetricsSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.totals.skipped).toBe(2);
    expect(snap!.totals.requests).toBe(2);

    await limiter.shutdownMetrics();
    vi.restoreAllMocks();
  }, 15_000);
});
