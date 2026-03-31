import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fastifyRateLimiter } from '../src/fastify.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RateLimitStrategy } from '../src/types/index.js';

const stores: MemoryStore[] = [];
function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const store = new MemoryStore(options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

describe('fastify plugin', () => {
  it('registers plugin and allows requests under limit with headers', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 3,
      }),
    });
    app.get('/ok', async () => ({ ok: true }));

    const r1 = await app.inject({ method: 'GET', url: '/ok' });
    const r2 = await app.inject({ method: 'GET', url: '/ok' });

    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-ratelimit-limit']).toBe('3');
    expect(r1.headers['x-ratelimit-remaining']).toBe('2');
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['x-ratelimit-remaining']).toBe('1');

    await app.close();
  });

  it('blocks over limit with 429 body and Retry-After', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    app.get('/ok', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/ok' });
    const blocked = await app.inject({ method: 'GET', url: '/ok' });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'Too many requests' });
    expect(blocked.headers['retry-after']).toBeTruthy();

    await app.close();
  });

  it('supports custom keyGenerator using API key header', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator: (req) => String((req.headers as Record<string, string>)['x-api-key'] ?? 'none'),
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    app.get('/ok', async () => ({ ok: true }));

    const a1 = await app.inject({ method: 'GET', url: '/ok', headers: { 'x-api-key': 'a' } });
    const a2 = await app.inject({ method: 'GET', url: '/ok', headers: { 'x-api-key': 'a' } });
    const b1 = await app.inject({ method: 'GET', url: '/ok', headers: { 'x-api-key': 'b' } });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    expect(b1.statusCode).toBe(200);

    await app.close();
  });

  it('supports skip function', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      skip: () => true,
      store: trackedStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    app.get('/ok', async () => ({ ok: true }));

    const r1 = await app.inject({ method: 'GET', url: '/ok' });
    const r2 = await app.inject({ method: 'GET', url: '/ok' });
    const r3 = await app.inject({ method: 'GET', url: '/ok' });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);

    await app.close();
  });

  it('supports skipFailedRequests', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      skipFailedRequests: true,
      store: trackedStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    app.get('/fail', async (_req, reply) => {
      return reply.status(500).send({ ok: false });
    });

    const r1 = await app.inject({ method: 'GET', url: '/fail' });
    const r2 = await app.inject({ method: 'GET', url: '/fail' });

    expect(r1.statusCode).toBe(500);
    expect(r2.statusCode).toBe(500);

    await app.close();
  });

  it('supports custom message string and object', async () => {
    const appString = Fastify();
    await appString.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      message: 'calm down',
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    appString.get('/ok', async () => ({ ok: true }));

    await appString.inject({ method: 'GET', url: '/ok' });
    const blockedString = await appString.inject({ method: 'GET', url: '/ok' });
    expect(blockedString.statusCode).toBe(429);
    expect(blockedString.json()).toEqual({ error: 'calm down' });
    await appString.close();

    const appObject = Fastify();
    await appObject.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      message: { code: 'RL_429' },
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    appObject.get('/ok', async () => ({ ok: true }));

    await appObject.inject({ method: 'GET', url: '/ok' });
    const blockedObject = await appObject.inject({ method: 'GET', url: '/ok' });
    expect(blockedObject.statusCode).toBe(429);
    expect(blockedObject.json()).toEqual({ error: { code: 'RL_429' } });
    await appObject.close();
  });

  it('supports skipSuccessfulRequests', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      skipSuccessfulRequests: true,
      store: trackedStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    app.get('/success', async () => ({ ok: true }));

    const r1 = await app.inject({ method: 'GET', url: '/success' });
    const r2 = await app.inject({ method: 'GET', url: '/success' });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    await app.close();
  });

  it('supports headers: false option', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
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
    app.get('/ok', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();

    await app.close();
  });

  it('supports custom statusCode', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      statusCode: 503,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });
    app.get('/ok', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/ok' });
    const blocked = await app.inject({ method: 'GET', url: '/ok' });
    expect(blocked.statusCode).toBe(503);

    await app.close();
  });

  it('exposes native Prometheus GET /metrics via fastifyMetricsRoute when prometheus is enabled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: trackedStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
      metrics: { enabled: true, intervalMs: 10_000, prometheus: { enabled: true } },
    });

    expect(app.fastifyMetricsRoute).toBeDefined();
    app.get('/metrics', app.fastifyMetricsRoute!);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/plain/);
    expect(res.payload).toContain('# HELP');

    await app.close();
    vi.restoreAllMocks();
  });
});
