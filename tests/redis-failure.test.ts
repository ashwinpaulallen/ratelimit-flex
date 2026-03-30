import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { expressRateLimiter } from '../src/middleware/express.js';
import { RateLimitEngine } from '../src/strategies/rate-limit-engine.js';
import type { RedisLikeClient } from '../src/stores/redis-store.js';
import { RedisStore } from '../src/stores/redis-store.js';
import { RateLimitStrategy } from '../src/types/index.js';

function throwingRedisClient(): RedisLikeClient {
  const reject = (): Promise<never> => Promise.reject(new Error('redis down'));
  return {
    get: reject,
    set: reject,
    eval: reject,
  };
}

const baseStoreOpts = {
  strategy: RateLimitStrategy.SLIDING_WINDOW as const,
  windowMs: 60_000,
  maxRequests: 100,
  client: throwingRedisClient(),
};

describe('RedisStore onRedisError', () => {
  it('defaults to fail-open when omitted', async () => {
    const store = new RedisStore(baseStoreOpts);
    const r = await store.increment('k');
    expect(r.isBlocked).toBe(false);
    expect(r.storeUnavailable).toBeUndefined();
    await store.shutdown();
  });

  it('fail-open: increment allows traffic when Redis throws', async () => {
    const store = new RedisStore({
      ...baseStoreOpts,
      onRedisError: 'fail-open',
    });
    const r = await store.increment('k');
    expect(r.isBlocked).toBe(false);
    expect(r.storeUnavailable).toBeUndefined();
    await store.shutdown();
  });

  it('fail-closed: increment blocks with storeUnavailable', async () => {
    const store = new RedisStore({
      ...baseStoreOpts,
      onRedisError: 'fail-closed',
    });
    const r = await store.increment('k');
    expect(r.isBlocked).toBe(true);
    expect(r.storeUnavailable).toBe(true);
    await store.shutdown();
  });

  it('decrement does not throw in either mode', async () => {
    for (const mode of ['fail-open', 'fail-closed'] as const) {
      const store = new RedisStore({
        ...baseStoreOpts,
        onRedisError: mode,
      });
      await expect(store.decrement('k')).resolves.toBeUndefined();
      await store.shutdown();
    }
  });

  it('reset resolves in fail-open when Redis throws', async () => {
    const store = new RedisStore({
      ...baseStoreOpts,
      onRedisError: 'fail-open',
    });
    await expect(store.reset('k')).resolves.toBeUndefined();
    await store.shutdown();
  });

  it('reset rejects in fail-closed when Redis throws', async () => {
    const store = new RedisStore({
      ...baseStoreOpts,
      onRedisError: 'fail-closed',
    });
    await expect(store.reset('k')).rejects.toThrow('redis down');
    await store.shutdown();
  });
});

describe('RateLimitEngine + Redis fail modes', () => {
  it('maps fail-closed to service_unavailable blockReason', async () => {
    const store = new RedisStore({
      ...baseStoreOpts,
      onRedisError: 'fail-closed',
    });
    const engine = new RateLimitEngine({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store,
    });
    const r = await engine.consumeWithKey('user-1', {});
    expect(r.isBlocked).toBe(true);
    expect(r.storeUnavailable).toBe(true);
    expect(r.blockReason).toBe('service_unavailable');
    await store.shutdown();
  });
});

describe('Express + Redis failure', () => {
  const stores: RedisStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.shutdown()));
  });

  function trackStore(opts: ConstructorParameters<typeof RedisStore>[0]) {
    const s = new RedisStore(opts);
    stores.push(s);
    return s;
  }

  it('returns 503 with fail-closed RedisStore', async () => {
    const store = trackStore({
      ...baseStoreOpts,
      onRedisError: 'fail-closed',
    });
    const app = express();
    app.use(expressRateLimiter({ strategy: RateLimitStrategy.SLIDING_WINDOW, store }));
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Service temporarily unavailable' });
  });

  it('returns 200 with fail-open RedisStore', async () => {
    const store = trackStore({
      ...baseStoreOpts,
      onRedisError: 'fail-open',
    });
    const app = express();
    app.use(expressRateLimiter({ strategy: RateLimitStrategy.SLIDING_WINDOW, store }));
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
