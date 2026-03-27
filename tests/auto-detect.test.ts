import express from 'express';
import Fastify from 'fastify';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/index.js';
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

describe('createRateLimiter convenience factory', () => {
  it('creates Express middleware via .express', async () => {
    const limiter = createRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 2,
      }),
    });

    const app = express();
    app.use(limiter.express);
    app.get('/ok', (_req, res) => res.json({ ok: true }));

    const r1 = await request(app).get('/ok');
    const r2 = await request(app).get('/ok');
    const r3 = await request(app).get('/ok');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  it('creates Fastify plugin via .fastify', async () => {
    const limiter = createRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 2,
      }),
    });

    const app = Fastify();
    await app.register(limiter.fastify);
    app.get('/ok', async () => ({ ok: true }));

    const r1 = await app.inject({ method: 'GET', url: '/ok' });
    const r2 = await app.inject({ method: 'GET', url: '/ok' });
    const r3 = await app.inject({ method: 'GET', url: '/ok' });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);

    await app.close();
  });
});
