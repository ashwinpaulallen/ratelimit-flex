import express from 'express';
import Fastify from 'fastify';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { fastifyRateLimiter } from '../../src/fastify.js';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import { createRateLimiter } from '../../src/strategies/rate-limit-engine.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const stores: MemoryStore[] = [];
function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const store = new MemoryStore(options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

describe('KeyManager middleware integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call store.increment when keyManager blocks (Express)', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const incSpy = vi.spyOn(store, 'increment');
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });
    await km.block('client-a', 120_000, { type: 'manual' });

    const app = express();
    app.use(express.json());
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 3,
        store,
        keyManager: km,
        keyGenerator: () => 'client-a',
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(429);
    expect(incSpy).not.toHaveBeenCalled();
  });

  it('returns block reason and expiresAt in JSON body (Express)', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });
    await km.block('client-a', 120_000, { type: 'manual' });

    const app = express();
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 3,
        store,
        keyManager: km,
        keyGenerator: () => 'client-a',
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: 'Too many requests',
      blocked: true,
      reason: 'manual',
    });
    expect(res.body.expiresAt).toBe('2026-04-05T12:02:00.000Z');
  });

  it('sets Retry-After from block expiry (Express)', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });
    await km.block('client-a', 120_000, { type: 'manual' });

    const app = express();
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 3,
        store,
        keyManager: km,
        keyGenerator: () => 'client-a',
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('120');
  });

  it('exposes keyManager on the Express handler', () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      store,
      keyManager: km,
    });
    expect(limiter.keyManager).toBe(km);
  });

  it('auto-creates KeyManager from penaltyBox when keyManager omitted', () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      store,
      penaltyBox: {
        violationsThreshold: 3,
        penaltyDurationMs: 120_000,
      },
    });
    expect(limiter.keyManager).toBeInstanceOf(KeyManager);
  });

  it('throws when both penaltyBox and keyManager are provided', () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const km = new KeyManager({ store, maxRequests: 10, windowMs: 60_000 });
    expect(() =>
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        store,
        keyManager: km,
        penaltyBox: { violationsThreshold: 2, penaltyDurationMs: 1000 },
      }),
    ).toThrow("Cannot use both 'penaltyBox' and 'keyManager'");
  });

  it('mergeRateLimiterOptions throws for penaltyBox + keyManager', () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    stores.push(store);
    const km = new KeyManager({ store, maxRequests: 10, windowMs: 60_000 });
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        store,
        keyManager: km,
        penaltyBox: { violationsThreshold: 2, penaltyDurationMs: 1000 },
      }),
    ).toThrow("Cannot use both 'penaltyBox' and 'keyManager'");
  });

  it('RateLimitEngine skips increment when keyManager blocks', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const incSpy = vi.spyOn(store, 'increment');
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });
    await km.block('k1', 60_000, { type: 'manual' });

    const resolved = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      store,
      keyManager: km,
    });
    const engine = createRateLimiter(resolved);
    expect(engine.keyManager).toBe(km);

    const result = await engine.consumeWithKey('k1');
    expect(result.isBlocked).toBe(true);
    expect(result.blockReason).toBe('key_manager');
    expect(incSpy).not.toHaveBeenCalled();
  });

  it('decorates fastify.keyManager when keyManager is set', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });

    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      store,
      keyManager: km,
      keyGenerator: () => 'client-a',
    });
    app.get('/ok', async () => ({ ok: true }));

    expect(app.keyManager).toBe(km);

    await app.close();
  });

  it('decorates fastify.keyManager when only penaltyBox is set', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      store,
      penaltyBox: { violationsThreshold: 4, penaltyDurationMs: 30_000 },
    });
    app.get('/ok', async () => ({ ok: true }));

    expect(app.keyManager).toBeInstanceOf(KeyManager);

    await app.close();
  });

  it('returns key_manager block JSON from Fastify when blocked', async () => {
    const store = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
    });
    const km = new KeyManager({ store, maxRequests: 3, windowMs: 1000 });
    await km.block('client-a', 120_000, { type: 'manual' });

    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 3,
      store,
      keyManager: km,
      keyGenerator: () => 'client-a',
    });
    app.get('/ok', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(429);
    const body = res.json() as Record<string, unknown>;
    expect(body.blocked).toBe(true);
    expect(body.reason).toBe('manual');
    expect(res.headers['retry-after']).toBe('120');

    await app.close();
  });
});
