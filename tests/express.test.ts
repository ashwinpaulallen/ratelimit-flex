import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { expressRateLimiter } from '../src/middleware/express.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RateLimitStrategy } from '../src/types/index.js';

function createExpressApp(
  options: Parameters<typeof expressRateLimiter>[0],
  routes?: (app: express.Express) => void,
) {
  const app = express();
  app.use(express.json());
  app.use(expressRateLimiter(options));
  if (routes) {
    routes(app);
  } else {
    app.get('/ok', (_req, res) => {
      res.status(200).json({ ok: true });
    });
  }
  return app;
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

describe('express middleware', () => {
  it('allows requests under limit and sets headers', async () => {
    const app = createExpressApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 3,
      }),
    });

    const res1 = await request(app).get('/ok');
    const res2 = await request(app).get('/ok');

    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-limit']).toBe('3');
    expect(res1.headers['x-ratelimit-remaining']).toBe('2');
    expect(res1.headers['x-ratelimit-reset']).toBeTruthy();
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('blocks over limit with 429 body and Retry-After', async () => {
    const app = createExpressApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });

    await request(app).get('/ok');
    const blocked = await request(app).get('/ok');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many requests' });
    expect(blocked.headers['retry-after']).toBeTruthy();
  });

  it('supports custom keyGenerator using API key header', async () => {
    const app = createExpressApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator: (req) => String((req as express.Request).header('x-api-key') ?? 'none'),
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });

    const a1 = await request(app).get('/ok').set('x-api-key', 'a');
    const a2 = await request(app).get('/ok').set('x-api-key', 'a');
    const b1 = await request(app).get('/ok').set('x-api-key', 'b');

    expect(a1.status).toBe(200);
    expect(a2.status).toBe(429);
    expect(b1.status).toBe(200);
  });

  it('supports skip function', async () => {
    const app = createExpressApp({
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

    const r1 = await request(app).get('/ok');
    const r2 = await request(app).get('/ok');
    const r3 = await request(app).get('/ok');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it('supports skipFailedRequests', async () => {
    const app = createExpressApp(
      {
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        skipFailedRequests: true,
        store: trackedStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      },
      (a) => {
        a.get('/fail', (_req, res) => {
          res.status(500).json({ ok: false });
        });
      },
    );

    const r1 = await request(app).get('/fail');
    const r2 = await request(app).get('/fail');

    expect(r1.status).toBe(500);
    expect(r2.status).toBe(500);
  });

  it('supports custom message string and object', async () => {
    const appString = createExpressApp({
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

    await request(appString).get('/ok');
    const blockedString = await request(appString).get('/ok');
    expect(blockedString.status).toBe(429);
    expect(blockedString.body).toEqual({ error: 'calm down' });

    const appObject = createExpressApp({
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

    await request(appObject).get('/ok');
    const blockedObject = await request(appObject).get('/ok');
    expect(blockedObject.status).toBe(429);
    expect(blockedObject.body).toEqual({ error: { code: 'RL_429' } });
  });

  it('supports skipSuccessfulRequests', async () => {
    const app = createExpressApp(
      {
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        skipSuccessfulRequests: true,
        store: trackedStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      },
      (a) => {
        a.get('/success', (_req, res) => {
          res.status(200).json({ ok: true });
        });
      },
    );

    const r1 = await request(app).get('/success');
    const r2 = await request(app).get('/success');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('supports headers: false option', async () => {
    const app = createExpressApp({
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
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('supports custom statusCode', async () => {
    const app = createExpressApp({
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

    await request(app).get('/ok');
    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(503);
  });
});
