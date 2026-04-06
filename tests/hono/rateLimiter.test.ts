import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitStore,
} from '../../src/types/index.js';
import { rateLimiter, honoDefaultKeyGenerator } from '../../src/hono/rateLimiter.js';

function getApp() {
  return new Hono();
}

describe('rateLimiter (Hono)', () => {
  it('allows requests under the limit', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 5, windowMs: 60_000 }));
    app.get('/r', (c) => c.text('ok'));

    const res = await app.request('http://test/r', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns 429 when over the limit', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 2, windowMs: 60_000 }));
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.2' };
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    const blocked = await app.request('http://test/r', { headers: h });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error?: string };
    expect(body.error).toBe('Too many requests');
  });

  it('uses custom keyGenerator', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        keyGenerator: (c) => c.req.header('x-api-key') ?? 'anon',
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-api-key': 'key-a' };
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/r', { headers: h })).status).toBe(429);
    expect((await app.request('http://test/r', { headers: { 'x-api-key': 'key-b' } })).status).toBe(200);
  });

  it('custom message: string', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 1, windowMs: 60_000, message: 'slow down' }));
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.10' };
    await app.request('http://test/r', { headers: h });
    const res = await app.request('http://test/r', { headers: h });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('slow down');
  });

  it('custom message: object', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 1, windowMs: 60_000, message: { custom: 'nope' } }));
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.11' };
    await app.request('http://test/r', { headers: h });
    const res = await app.request('http://test/r', { headers: h });
    const body = (await res.json()) as { error?: { custom?: string } };
    expect(body.error?.custom).toBe('nope');
  });

  it('custom message: function returns Response', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        message: (c) => c.text('custom-body', 429),
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.12' };
    await app.request('http://test/r', { headers: h });
    const res = await app.request('http://test/r', { headers: h });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('custom-body');
  });

  it('skip bypasses limiting', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        skip: (c) => c.req.header('x-bypass') === '1',
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.13', 'x-bypass': '1' };
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
  });

  it('allowlist bypasses limiting', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        keyGenerator: (c) => c.req.header('x-id') ?? 'x',
        allowlist: ['vip'],
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-id': 'vip' };
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
  });

  it('blocklist returns 403', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 100,
        windowMs: 60_000,
        keyGenerator: (c) => c.req.header('x-id') ?? 'x',
        blocklist: ['bad'],
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const res = await app.request('http://test/r', { headers: { 'x-id': 'bad' } });
    expect(res.status).toBe(403);
  });

  it('sets legacy X-RateLimit-* headers', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 3, windowMs: 60_000, standardHeaders: 'legacy' }));
    app.get('/r', (c) => c.text('ok'));

    const res = await app.request('http://test/r', { headers: { 'x-forwarded-for': '10.0.0.20' } });
    expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
  });

  it('sets draft-7 headers when configured', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 3,
        windowMs: 60_000,
        standardHeaders: 'draft-7',
        legacyHeaders: true,
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const res = await app.request('http://test/r', { headers: { 'x-forwarded-for': '10.0.0.21' } });
    expect(res.headers.get('RateLimit')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
  });

  it('applies cost for weighted increments', async () => {
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 5,
        windowMs: 60_000,
        cost: 3,
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.30' };
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/r', { headers: h })).status).toBe(429);
  });

  it('calls onLimitReached when rate limited', async () => {
    const onLimitReached = vi.fn();
    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        onLimitReached,
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.40' };
    await app.request('http://test/r', { headers: h });
    await app.request('http://test/r', { headers: h });
    expect(onLimitReached).toHaveBeenCalledTimes(1);
    expect(onLimitReached.mock.calls[0]?.[1]).toBe('10.0.0.40');
  });

  it('stores rateLimitResult on the context for downstream handlers', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 5, windowMs: 60_000 }));
    app.get('/r', (c) => {
      const r = c.get('rateLimitResult');
      expect(r).toBeDefined();
      expect(r?.remaining).toBeDefined();
      return c.text('ok');
    });

    const res = await app.request('http://test/r', { headers: { 'x-forwarded-for': '10.0.0.50' } });
    expect(res.status).toBe(200);
  });

  it('uses MemoryStore by default', async () => {
    const app = getApp();
    app.use('*', rateLimiter({ maxRequests: 1, windowMs: 60_000 }));
    app.get('/r', (c) => c.text('ok'));

    const h = { 'x-forwarded-for': '10.0.0.60' };
    expect((await app.request('http://test/r', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/r', { headers: h })).status).toBe(429);
  });

  it('uses a custom store (mock)', async () => {
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const incrementSpy = vi.spyOn(inner, 'increment');

    const mockStore: RateLimitStore = {
      increment: (key: string, opts?: RateLimitIncrementOptions) => inner.increment(key, opts),
      decrement: (key: string, opts?: RateLimitDecrementOptions) => inner.decrement(key, opts),
      reset: (key: string) => inner.reset(key),
      shutdown: () => inner.shutdown(),
    };

    const app = getApp();
    app.use(
      '*',
      rateLimiter({
        store: mockStore,
        maxRequests: 10,
        windowMs: 60_000,
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    await app.request('http://test/r', { headers: { 'x-forwarded-for': '10.0.0.70' } });
    expect(incrementSpy).toHaveBeenCalled();
  });

  it('exposes honoDefaultKeyGenerator', async () => {
    const app = getApp();
    
    app.use(
      '*',
      rateLimiter({
        maxRequests: 10,
        windowMs: 60_000,
        keyGenerator: (c) => {
          const apiKey = c.req.header('x-api-key');
          return apiKey ?? honoDefaultKeyGenerator(c);
        },
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    expect(honoDefaultKeyGenerator).toBeDefined();
    expect(typeof honoDefaultKeyGenerator).toBe('function');

    // Test that it works
    const res = await app.request('http://test/r', { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
  });

  it('supports metrics via HonoRateLimiterHandler', async () => {
    const app = getApp();
    const limiter = rateLimiter({
      maxRequests: 5,
      windowMs: 60_000,
      metrics: {
        enabled: true,
        snapshotIntervalMs: 1000,
      },
    });
    app.use('*', limiter);
    app.get('/r', (c) => c.text('ok'));

    expect(limiter.metricsManager).toBeDefined();
    expect(limiter.getMetricsSnapshot).toBeDefined();
    expect(limiter.getMetricsHistory).toBeDefined();
    expect(limiter.shutdown).toBeDefined();

    await app.request('http://test/r', { headers: { 'x-forwarded-for': '10.0.0.80' } });
    
    const snapshot = limiter.getMetricsSnapshot();
    expect(snapshot).toBeDefined();

    await limiter.shutdown();
  });

  it('handles errors gracefully with error wrapper', async () => {
    const app = getApp();
    const mockStore: RateLimitStore = {
      increment: () => {
        throw new Error('Store failure');
      },
      decrement: () => Promise.resolve({ success: true }),
      reset: () => Promise.resolve({ success: true }),
      shutdown: () => Promise.resolve(),
    };

    app.use(
      '*',
      rateLimiter({
        store: mockStore,
        maxRequests: 10,
        windowMs: 60_000,
      }),
    );
    app.get('/r', (c) => c.text('ok'));

    const res = await app.request('http://test/r', { headers: { 'x-forwarded-for': '10.0.0.90' } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Internal server error');
  });
});
