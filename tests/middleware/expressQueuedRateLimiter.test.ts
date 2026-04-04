import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { expressQueuedRateLimiter } from '../../src/middleware/expressQueuedRateLimiter.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('expressQueuedRateLimiter', () => {
  /** Real timers — fake timers interfere with supertest/Express scheduling for queue waits. */

  it('passes through immediately when under limit', async () => {
    const app = express();
    app.use(
      expressQueuedRateLimiter({
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: true,
      }),
    );
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    const r = await request(app).get('/ok');
    expect(r.status).toBe(200);
    expect(r.text).toBe('ok');
    expect(r.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('queues when over limit and eventually passes', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 2000,
      maxRequests: 1,
    });
    const app = express();
    const mw = expressQueuedRateLimiter({
      /** Wider than typical supertest inter-request delay (~80ms) so the 2nd request still hits a full window. */
      windowMs: 2000,
      maxRequests: 1,
      maxQueueSize: 10,
      standardHeaders: false,
      store,
      /** Supertest can vary connection identity per request; pin the key for deterministic queuing. */
      keyGenerator: () => 'queue-test',
    });
    app.use(mw);
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    const agent = request.agent(app);
    const r1 = await agent.get('/ok');
    expect(r1.status).toBe(200);
    expect(store.getActiveKeys().get('queue-test')?.totalHits).toBe(1);

    const b = agent.get('/ok');
    const t0 = Date.now();
    const r2 = await b;
    const elapsed = Date.now() - t0;
    expect(r2.status).toBe(200);
    /** Second call waits on the queue until the sliding window can accept it (not instant). */
    expect(elapsed).toBeGreaterThan(800);
    expect(mw.queue.getQueueSize()).toBe(0);
    await store.shutdown();
  });

  it('responds 429 when queue is full', async () => {
    const app = express();
    app.use(
      expressQueuedRateLimiter({
        windowMs: 2000,
        maxRequests: 1,
        maxQueueSize: 1,
        standardHeaders: false,
        message: 'too busy',
        keyGenerator: () => 'queue-full-test',
      }),
    );
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    await request(app).get('/ok');

    /** Two in-flight requests; order of middleware entry is not guaranteed, so one gets 200 and one 429 (queue size 1). */
    const p2 = request(app).get('/ok');
    await new Promise<void>((r) => setTimeout(r, 0));
    const p3 = request(app).get('/ok');

    const [rA, rB] = await Promise.all([p2, p3]);
    const statuses = [rA.status, rB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);
    const rejected = rA.status === 429 ? rA : rB;
    expect(rejected.body).toEqual({ error: 'too busy' });
    expect(rejected.headers['retry-after']).toBe('1');
  });

  it('responds 429 on queue timeout', async () => {
    const app = express();
    app.use(
      expressQueuedRateLimiter({
        windowMs: 60_000,
        maxRequests: 1,
        maxQueueTimeMs: 80,
        maxQueueSize: 10,
        standardHeaders: false,
        keyGenerator: () => 'queue-timeout-test',
      }),
    );
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    const agent = request.agent(app);
    await agent.get('/ok');
    const pending = agent.get('/ok');
    await new Promise<void>((r) => setTimeout(r, 150));

    const r = await pending;
    expect(r.status).toBe(429);
    expect(String((r.body as { error?: string })?.error ?? r.text)).toContain('timeout');
    expect(r.headers['retry-after']).toBe('1');
  });

  it('uses custom keyGenerator so different keys have independent limits', async () => {
    const app = express();
    app.use(
      expressQueuedRateLimiter({
        windowMs: 60_000,
        maxRequests: 1,
        standardHeaders: false,
        keyGenerator: (req: unknown) => (req as express.Request).get('X-User') ?? 'anon',
      }),
    );
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    const a = await request(app).get('/ok').set('X-User', 'u1');
    const b = await request(app).get('/ok').set('X-User', 'u2');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('sets rate limit headers when standardHeaders is legacy', async () => {
    const app = express();
    app.use(
      expressQueuedRateLimiter({
        windowMs: 60_000,
        maxRequests: 5,
        standardHeaders: 'legacy',
      }),
    );
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    const r = await request(app).get('/ok');
    expect(r.status).toBe(200);
    expect(r.headers['x-ratelimit-limit']).toBe('5');
    expect(r.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('exposes queue on the handler', () => {
    const mw = expressQueuedRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      standardHeaders: false,
    });
    expect(mw.queue).toBeDefined();
    expect(typeof mw.queue.getQueueSize).toBe('function');
    expect(typeof mw.queue.clear).toBe('function');
  });

  it('accepts a custom store', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
    });
    const app = express();
    app.use(
      expressQueuedRateLimiter({
        windowMs: 60_000,
        maxRequests: 3,
        store,
        standardHeaders: false,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).send('ok'));

    const r = await request(app).get('/ok');
    expect(r.status).toBe(200);
    await store.shutdown();
  });
});
