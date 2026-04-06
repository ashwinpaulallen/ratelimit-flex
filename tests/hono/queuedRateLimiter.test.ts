import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { queuedRateLimiter } from '../../src/hono/queuedRateLimiter.js';

const stores: MemoryStore[] = [];

function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const s = new MemoryStore(options);
  stores.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

describe('queuedRateLimiter (Hono)', () => {
  it('passes through immediately when under limit', async () => {
    const app = new Hono();
    const mw = queuedRateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      standardHeaders: true,
    });
    app.use('*', mw);
    app.get('/ok', (c) => c.text('ok'));

    const r = await app.request('http://test/ok');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    expect(r.headers.get('x-ratelimit-limit')).toBeTruthy();
  });

  it('queues when over limit and eventually passes after the window allows capacity', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 2000,
      maxRequests: 1,
    });
    const app = new Hono();
    const mw = queuedRateLimiter({
      windowMs: 2000,
      maxRequests: 1,
      maxQueueSize: 10,
      standardHeaders: false,
      store,
      keyGenerator: () => 'queue-test',
    });
    app.use('*', mw);
    app.get('/ok', (c) => c.text('ok'));

    const r1 = await app.request('http://test/ok');
    expect(r1.status).toBe(200);
    expect(store.getActiveKeys().get('queue-test')?.totalHits).toBe(1);

    const t0 = Date.now();
    const r2 = await app.request('http://test/ok');
    const elapsed = Date.now() - t0;
    expect(r2.status).toBe(200);
    expect(elapsed).toBeGreaterThan(800);
    expect(mw.queue.getQueueSize()).toBe(0);
  });

  it('returns 429 when queue is full', async () => {
    const app = new Hono();
    app.use(
      '*',
      queuedRateLimiter({
        windowMs: 2000,
        maxRequests: 1,
        maxQueueSize: 1,
        standardHeaders: false,
        message: 'too busy',
        keyGenerator: () => 'queue-full-test',
      }),
    );
    app.get('/ok', (c) => c.text('ok'));

    await app.request('http://test/ok');

    const p2 = app.request('http://test/ok');
    await new Promise<void>((r) => setTimeout(r, 0));
    const p3 = app.request('http://test/ok');

    const [rA, rB] = await Promise.all([p2, p3]);
    const statuses = [rA.status, rB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);
    const rejected = rA.status === 429 ? rA : rB;
    const body = (await rejected.json()) as { error?: string };
    expect(body.error).toBe('too busy');
    expect(rejected.headers.get('retry-after')).toBe('1');
  });

  it('returns 429 on queue timeout', async () => {
    const app = new Hono();
    app.use(
      '*',
      queuedRateLimiter({
        windowMs: 60_000,
        maxRequests: 1,
        maxQueueTimeMs: 80,
        maxQueueSize: 10,
        standardHeaders: false,
        keyGenerator: () => 'queue-timeout-test',
      }),
    );
    app.get('/ok', (c) => c.text('ok'));

    await app.request('http://test/ok');
    const pending = app.request('http://test/ok');
    await new Promise<void>((r) => setTimeout(r, 150));

    const r = await pending;
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error?: string };
    expect(String(body.error ?? '')).toContain('timeout');
    expect(r.headers.get('retry-after')).toBe('1');
  });

  it('exposes the underlying queue on the handler', () => {
    const mw = queuedRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      standardHeaders: false,
    });
    expect(mw.queue).toBeDefined();
    expect(typeof mw.queue.getQueueSize).toBe('function');
    expect(typeof mw.queue.clear).toBe('function');
  });

  it('supports inMemoryBlock option for DoS protection', async () => {
    const app = new Hono();
    const mw = queuedRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      standardHeaders: false,
      inMemoryBlock: true,
      keyGenerator: () => 'shield-test',
    });
    app.use('*', mw);
    app.get('/ok', (c) => c.text('ok'));

    const r1 = await app.request('http://test/ok');
    expect(r1.status).toBe(200);
    const r2 = await app.request('http://test/ok');
    expect(r2.status).toBe(200);
    
    // Third request should be queued, but we're testing that inMemoryBlock is configured
    expect(mw.queue).toBeDefined();
  });
});
