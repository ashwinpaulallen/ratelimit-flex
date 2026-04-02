import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fastifyRateLimiter } from '../../src/fastify.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitOptions, RateLimitStore } from '../../src/types/index.js';

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

async function createApp(opts: Partial<RateLimitOptions>) {
  const app = Fastify();
  await app.register(fastifyRateLimiter, opts);
  app.get('/ok', async () => ({ ok: true }));
  return app;
}

describe('fastifyRateLimiter headers (match Express / formatRateLimitHeaders)', () => {
  it('headers: true (no standardHeaders) sends legacy X-RateLimit-* headers (same values as Express)', async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
    expect(res.headers['x-ratelimit-reset']).toBeTruthy();
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it('headers: false sends no rate limit headers', async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it("standardHeaders: 'draft-6' matches Express header values", async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
    expect(res.headers['ratelimit-policy']).toBe('5;w=60');
    const reset = Number(res.headers['ratelimit-reset']);
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThan(86400);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it("standardHeaders: 'draft-7' matches Express", async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.ratelimit).toMatch(/^limit=3, remaining=2, reset=\d+$/);
    expect(res.headers['ratelimit-policy']).toBe('3;w=60');
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it("standardHeaders: 'draft-8' matches Express", async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-policy']).toBe('"8-per-60";q=8;w=60');
    expect(res.headers.ratelimit).toMatch(/^"8-per-60";r=\d+;t=\d+$/);
    await app.close();
  });

  it("standardHeaders: 'draft-8' with identifier: 'api-v1' matches Express", async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-policy']).toBe('"api-v1";q=8;w=60');
    expect(res.headers.ratelimit).toMatch(/^"api-v1";r=\d+;t=\d+$/);
    await app.close();
  });

  it("standardHeaders: 'draft-6', legacyHeaders: true — dual headers like Express", async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('4');
    expect(res.headers['x-ratelimit-limit']).toBe('4');
    expect(res.headers['x-ratelimit-remaining']).toBe('3');
    await app.close();
  });

  it("standardHeaders: 'draft-8', legacyHeaders: false — only standard", async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-policy']).toBeTruthy();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    await app.close();
  });

  it('Retry-After on 429 only, absent on 200 (draft-6)', async () => {
    const app = await createApp({
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

    const ok = await app.inject({ method: 'GET', url: '/ok' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['retry-after']).toBeUndefined();

    const blocked = await app.inject({ method: 'GET', url: '/ok' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    await app.close();
  });

  it('draft-6 RateLimit-Reset is seconds-until-reset (not epoch)', async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    const reset = Number(res.headers['ratelimit-reset']);
    expect(reset).toBeLessThan(1_000_000_000);
    await app.close();
  });

  it('dynamic maxRequests (function) draft-8 identifier matches Express', async () => {
    const app = await createApp({
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

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.headers['ratelimit-policy']).toBe('"7-per-60";q=7;w=60');
    await app.close();
  });

  it('X-RateLimit-Store: fallback with draft-6 matches Express', async () => {
    const app = await createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      standardHeaders: 'draft-6',
      store: mockStoreWithFallback(),
    });

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.headers['x-ratelimit-store']).toBe('fallback');
    expect(res.headers['ratelimit-limit']).toBe('100');
    await app.close();
  });
});
