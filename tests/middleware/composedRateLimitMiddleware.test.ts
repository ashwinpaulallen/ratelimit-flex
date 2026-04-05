import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/composition/compose.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import type { RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('ComposedStore + expressRateLimiter', () => {
  it('rejects merge when both limits and store are set', () => {
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [{ windowMs: 60_000, max: 10 }],
        store: {} as RateLimitStore,
      }),
    ).toThrow(/mutually exclusive/i);
  });

  it('uses ComposedStore via store option and exposes rateLimitComposed with layers', async () => {
    const perSec = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 100,
    });
    const perMin = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const composed = compose.all(compose.layer('per-sec', perSec), compose.layer('per-min', perMin));

    const app = express();
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
        store: composed,
      }),
    );
    app.get('/ok', (req, res) => {
      expect(req.rateLimitComposed?.layers).toBeDefined();
      expect(req.rateLimitComposed?.layers?.['per-sec']).toBeDefined();
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    await composed.shutdown();
  });

  it('onLayerBlock fires for blocked layers; onLimitReached receives composed result with layers', async () => {
    const tight = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
    });
    const loose = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const composed = compose.all(compose.layer('tight', tight), compose.layer('loose', loose));

    const onLayerBlock = vi.fn();
    const onLimitReached = vi.fn();

    const app = express();
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
        store: composed,
        onLayerBlock,
        onLimitReached,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    expect((await request(app).get('/ok')).status).toBe(200);
    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(429);
    expect(onLayerBlock.mock.calls.some((c) => c[1] === 'tight')).toBe(true);
    expect(onLimitReached).toHaveBeenCalledTimes(1);
    const limitArg = onLimitReached.mock.calls[0]![1];
    expect(limitArg.layers).toBeDefined();
    expect(limitArg.layers?.tight?.isBlocked).toBe(true);

    await composed.shutdown();
  });

  it('standardHeaders remaining reflects tightest layer across limits (composed)', async () => {
    const app = express();
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        standardHeaders: true,
        limits: [
          { windowMs: 60_000, max: 100 },
          { windowMs: 60_000, max: 5 },
        ],
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(Number(res.headers['x-ratelimit-limit'])).toBe(5);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(4);
  });

  it('limits array still blocks when any window is exceeded', async () => {
    const app = express();
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [
          { windowMs: 60_000, max: 100 },
          { windowMs: 60_000, max: 1 },
        ],
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    expect((await request(app).get('/ok')).status).toBe(200);
    expect((await request(app).get('/ok')).status).toBe(429);
  });
});
