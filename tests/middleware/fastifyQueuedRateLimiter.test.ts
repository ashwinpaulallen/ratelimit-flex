import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { fastifyQueuedRateLimiter } from '../../src/middleware/fastifyQueuedRateLimiter.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (a) => {
      await a.close();
    }),
  );
});

function trackApp(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

describe('fastifyQueuedRateLimiter', () => {
  it('passes through immediately when under limit', async () => {
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 60_000,
      maxRequests: 10,
      standardHeaders: true,
    });
    app.get('/ok', async () => 'ok');

    const r = await app.inject({ method: 'GET', url: '/ok' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('ok');
    expect(r.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('queues when over limit and eventually passes', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 2000,
      maxRequests: 1,
    });
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 2000,
      maxRequests: 1,
      maxQueueSize: 10,
      standardHeaders: false,
      store,
      keyGenerator: () => 'queue-test',
    });
    app.get('/ok', async () => 'ok');

    const r1 = await app.inject({ method: 'GET', url: '/ok' });
    expect(r1.statusCode).toBe(200);
    expect(store.getActiveKeys().get('queue-test')?.totalHits).toBe(1);

    const p2 = app.inject({ method: 'GET', url: '/ok' });
    const t0 = Date.now();
    const r2 = await p2;
    const elapsed = Date.now() - t0;
    expect(r2.statusCode).toBe(200);
    expect(elapsed).toBeGreaterThan(800);
    expect(app.rateLimitQueue!.getQueueSize()).toBe(0);
    await store.shutdown();
  });

  it('responds 429 when queue is full', async () => {
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 2000,
      maxRequests: 1,
      maxQueueSize: 1,
      standardHeaders: false,
      message: 'too busy',
      keyGenerator: () => 'queue-full-test',
    });
    app.get('/ok', async () => 'ok');

    await app.inject({ method: 'GET', url: '/ok' });

    const p2 = app.inject({ method: 'GET', url: '/ok' });
    await new Promise<void>((r) => setTimeout(r, 0));
    const p3 = app.inject({ method: 'GET', url: '/ok' });

    const [rA, rB] = await Promise.all([p2, p3]);
    const statuses = [rA.statusCode, rB.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);
    const rejected = rA.statusCode === 429 ? rA : rB;
    expect(rejected.json()).toEqual({ error: 'too busy' });
    expect(rejected.headers['retry-after']).toBe('1');
  });

  it('responds 429 on queue timeout', async () => {
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 60_000,
      maxRequests: 1,
      maxQueueTimeMs: 80,
      maxQueueSize: 10,
      standardHeaders: false,
      keyGenerator: () => 'queue-timeout-test',
    });
    app.get('/ok', async () => 'ok');

    await app.inject({ method: 'GET', url: '/ok' });
    const pending = app.inject({ method: 'GET', url: '/ok' });
    await new Promise<void>((r) => setTimeout(r, 150));

    const r = await pending;
    expect(r.statusCode).toBe(429);
    expect(String(r.json<{ error?: string }>().error ?? r.body)).toContain('timeout');
    expect(r.headers['retry-after']).toBe('1');
  });

  it('uses custom keyGenerator so different keys have independent limits', async () => {
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 60_000,
      maxRequests: 1,
      standardHeaders: false,
      keyGenerator: (req) => {
        const h = (req as import('fastify').FastifyRequest).headers['x-user'];
        return (Array.isArray(h) ? h[0] : h) ?? 'anon';
      },
    });
    app.get('/ok', async () => 'ok');

    const a = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { 'x-user': 'u1' },
    });
    const b = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { 'x-user': 'u2' },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it('sets rate limit headers when standardHeaders is legacy', async () => {
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 60_000,
      maxRequests: 5,
      standardHeaders: 'legacy',
    });
    app.get('/ok', async () => 'ok');

    const r = await app.inject({ method: 'GET', url: '/ok' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-ratelimit-limit']).toBe('5');
    expect(r.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('decorates fastify with rateLimitQueue', async () => {
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 1000,
      maxRequests: 2,
      standardHeaders: false,
    });
    expect(app.rateLimitQueue).toBeDefined();
    expect(typeof app.rateLimitQueue!.getQueueSize).toBe('function');
    expect(typeof app.rateLimitQueue!.clear).toBe('function');
  });

  it('accepts a custom store', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    });
    const app = trackApp(Fastify());
    await app.register(fastifyQueuedRateLimiter, {
      windowMs: 60_000,
      maxRequests: 3,
      store,
      standardHeaders: false,
    });
    app.get('/ok', async () => 'ok');

    const r = await app.inject({ method: 'GET', url: '/ok' });
    expect(r.statusCode).toBe(200);
    await store.shutdown();
  });
});
