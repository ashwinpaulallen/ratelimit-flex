import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitStore } from '../../src/types/index.js';

function mockStoreWithFallback(): RateLimitStore {
  return {
    increment: vi.fn().mockResolvedValue({
      totalHits: 1,
      remaining: 9,
      resetTime: new Date(Date.now() + 60_000),
      isBlocked: false,
      storeUnavailable: true,
    }),
    decrement: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const stores: MemoryStore[] = [];
function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const store = new MemoryStore(options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

function createApp(opts: Parameters<typeof expressRateLimiter>[0]) {
  const app = express();
  app.use(expressRateLimiter(opts));
  app.get('/ok', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('expressRateLimiter headers (formatRateLimitHeaders)', () => {
  it('headers: true (no standardHeaders) sends legacy X-RateLimit-* headers', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      headers: true,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
    expect(res.headers['x-ratelimit-reset']).toBeTruthy();
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('headers: false sends no rate limit headers', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      headers: false,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it("standardHeaders: 'draft-6' sends RateLimit-* and RateLimit-Policy", async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 5,
      standardHeaders: 'draft-6',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 5,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
    expect(res.headers['ratelimit-policy']).toBe('5;w=60');
    const reset = Number(res.headers['ratelimit-reset']);
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThan(86400);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it("standardHeaders: 'draft-7' sends combined RateLimit and RateLimit-Policy", async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
      standardHeaders: 'draft-7',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 3,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers.ratelimit).toMatch(/^limit=3, remaining=2, reset=\d+$/);
    expect(res.headers['ratelimit-policy']).toBe('3;w=60');
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it("standardHeaders: 'draft-8' sends named-policy RateLimit + RateLimit-Policy", async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 8,
      standardHeaders: 'draft-8',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 8,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-policy']).toBe('"8-per-60";q=8;w=60');
    expect(res.headers.ratelimit).toMatch(/^"8-per-60";r=\d+;t=\d+$/);
  });

  it("standardHeaders: 'draft-8' with identifier: 'api-v1' uses custom policy name", async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 8,
      standardHeaders: 'draft-8',
      identifier: 'api-v1',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 8,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-policy']).toBe('"api-v1";q=8;w=60');
    expect(res.headers.ratelimit).toMatch(/^"api-v1";r=\d+;t=\d+$/);
  });

  it("standardHeaders: 'draft-6', legacyHeaders: true sends both standard and legacy headers", async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 4,
      standardHeaders: 'draft-6',
      legacyHeaders: true,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 4,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('4');
    expect(res.headers['x-ratelimit-limit']).toBe('4');
    expect(res.headers['x-ratelimit-remaining']).toBe('3');
  });

  it("standardHeaders: 'draft-8', legacyHeaders: false sends only standard headers", async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 2,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-policy']).toBeTruthy();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('Retry-After is present on 429 (rate limit) and absent on 200', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      standardHeaders: 'draft-6',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });

    const ok = await request(app).get('/ok');
    expect(ok.status).toBe(200);
    expect(ok.headers['retry-after']).toBeUndefined();

    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
  });

  it('draft-6 RateLimit-Reset is seconds-until-reset (not epoch)', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      standardHeaders: 'draft-6',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      }),
    });

    const res = await request(app).get('/ok');
    const reset = Number(res.headers['ratelimit-reset']);
    expect(reset).toBeLessThan(1_000_000_000);
  });

  it('dynamic maxRequests (function) uses resolved limit in draft-8 identifier', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: () => 7,
      standardHeaders: 'draft-8',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 7,
      }),
    });

    const res = await request(app).get('/ok');
    expect(res.headers['ratelimit-policy']).toBe('"7-per-60";q=7;w=60');
  });

  it('X-RateLimit-Store: fallback still set when standardHeaders is draft-6', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      standardHeaders: 'draft-6',
      store: mockStoreWithFallback(),
    });

    const res = await request(app).get('/ok');
    expect(res.headers['x-ratelimit-store']).toBe('fallback');
    expect(res.headers['ratelimit-limit']).toBe('100');
  });
});
