import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/composition/compose.js';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';
import { expressRateLimiter } from '../src/middleware/express.js';
import { RateLimitEngine } from '../src/strategies/rate-limit-engine.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('limits vs compose.windows equivalence', () => {
  it('merge(limits: [...]) matches explicit store: compose.windows(...) for consume sequence', async () => {
    const fromLimits = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      limits: [
        { windowMs: 1000, max: 10 },
        { windowMs: 60_000, max: 100 },
      ],
    });
    const fromCompose = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 10,
      store: compose.windows(
        { windowMs: 1000, maxRequests: 10 },
        { windowMs: 60_000, maxRequests: 100 },
      ),
    });

    const engineLimits = new RateLimitEngine(fromLimits);
    const engineCompose = new RateLimitEngine(fromCompose);

    for (let i = 0; i < 25; i++) {
      const k = `key-${i % 3}`;
      const a = await engineLimits.consumeWithKey(k, {});
      const b = await engineCompose.consumeWithKey(k, {});
      expect(a.isBlocked).toBe(b.isBlocked);
      expect(a.remaining).toBe(b.remaining);
      expect(a.totalHits).toBe(b.totalHits);
    }

    await fromLimits.store.shutdown();
    await fromCompose.store.shutdown();
  });
});

describe('limits + incrementCost', () => {
  it('applies incrementCost across composed windows like single store', async () => {
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      limits: [
        { windowMs: 60_000, max: 10 },
        { windowMs: 60_000, max: 100 },
      ],
      incrementCost: 5,
    });
    const engine = new RateLimitEngine(merged);

    const r1 = await engine.consumeWithKey('ic', {});
    const r2 = await engine.consumeWithKey('ic', {});
    const r3 = await engine.consumeWithKey('ic', {});

    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(false);
    expect(r3.isBlocked).toBe(true);

    await merged.store.shutdown();
  });
});

describe('limits + skipFailedRequests', () => {
  it('does not count failed responses toward limits', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        limits: [{ windowMs: 60_000, max: 1 }],
        skipFailedRequests: true,
      }),
    );
    app.get('/fail', (_req, res) => {
      res.status(500).json({ ok: false });
    });

    const r1 = await request(app).get('/fail');
    const r2 = await request(app).get('/fail');

    expect(r1.status).toBe(500);
    expect(r2.status).toBe(500);
  });
});
