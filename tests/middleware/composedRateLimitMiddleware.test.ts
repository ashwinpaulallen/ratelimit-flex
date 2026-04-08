import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/composition/compose.js';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { createRedisEvalEmulator } from '../helpers/redis-eval-emulator.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RedisStore } from '../../src/stores/redis-store.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import type { RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('ComposedStore + expressRateLimiter', () => {
  it('rejects merge when both limits and store are set (non-Redis template)', () => {
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [{ windowMs: 60_000, max: 10 }],
        store: {} as RateLimitStore,
      }),
    ).toThrow(/mutually exclusive/i);
  });

  it('rejects limits + ComposedStore', () => {
    const c = compose.windows(
      { windowMs: 60_000, maxRequests: 10 },
      { windowMs: 120_000, maxRequests: 100 },
    );
    expect(c).toBeInstanceOf(ComposedStore);
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [{ windowMs: 60_000, max: 10 }],
        store: c,
      }),
    ).toThrow(/composed/);
    void c.shutdown();
  });

  it('allows limits + MemoryStore (ignored)', () => {
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 50,
    });
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [{ windowMs: 60_000, max: 10 }],
        store: mem,
      }),
    ).not.toThrow();
    void mem.shutdown();
  });

  it('allows limits + sliding-window RedisStore template (no resilience)', () => {
    const client = createRedisEvalEmulator();
    const template = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      client,
      keyPrefix: 'rlf:mw:',
    });
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [{ windowMs: 60_000, max: 10 }],
        store: template,
      }),
    ).not.toThrow();
    void template.shutdown();
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
