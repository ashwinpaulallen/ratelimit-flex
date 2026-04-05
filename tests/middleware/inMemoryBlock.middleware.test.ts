import express from 'express';
import Fastify from 'fastify';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryShield, shield } from '../../src/shield/index.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { fastifyRateLimiter } from '../../src/fastify.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitStore } from '../../src/types/index.js';

function createRemoteLikeStore(maxRequests: number): RateLimitStore & { increment: ReturnType<typeof vi.fn> } {
  const counts = new Map<string, number>();
  const increment = vi.fn(async (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const isBlocked = n > maxRequests;
    return {
      totalHits: n,
      remaining: isBlocked ? 0 : Math.max(0, maxRequests - n),
      resetTime: new Date(Date.now() + 60_000),
      isBlocked,
    };
  });
  return {
    increment,
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

describe('inMemoryBlock middleware integration', () => {
  it('inMemoryBlock: 100 wraps remote store with InMemoryShield', () => {
    const remote = createRemoteLikeStore(100);
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: remote,
      inMemoryBlock: 100,
    });

    expect(limiter.shield).toBeInstanceOf(InMemoryShield);
  });

  it('inMemoryBlock: true uses maxRequests as block threshold', () => {
    const remote = createRemoteLikeStore(77);
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 77,
      store: remote,
      inMemoryBlock: true,
    });

    expect(limiter.shield).toBeInstanceOf(InMemoryShield);
  });

  it('inMemoryBlock object uses custom blockOnConsumed', () => {
    const remote = createRemoteLikeStore(50);
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: remote,
      inMemoryBlock: { blockOnConsumed: 50 },
    });

    expect(limiter.shield).toBeInstanceOf(InMemoryShield);
  });

  it('MemoryStore is not wrapped and logs a debug message', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const mem = trackedStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 10,
    });
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 10,
      store: mem,
      inMemoryBlock: 5,
    });

    expect(limiter.shield).toBeNull();
    expect(debug).toHaveBeenCalledWith(
      '[ratelimit-flex] inMemoryBlock: ignoring MemoryStore (already in-memory; no remote store calls to save).',
    );
    debug.mockRestore();
  });

  it('limiter.shield exposes InMemoryShield and getMetrics()', async () => {
    const remote = createRemoteLikeStore(3);
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 3,
      store: remote,
      inMemoryBlock: 3,
      keyGenerator: () => 'one',
    });

    const app = express();
    app.use(limiter);
    app.get('/ok', (_req, res) => res.status(200).send('ok'));

    await request(app).get('/ok');
    await request(app).get('/ok');
    await request(app).get('/ok');
    await request(app).get('/ok');

    expect(limiter.shield).not.toBeNull();
    const m = limiter.shield!.getMetrics();
    expect(m.storeCalls).toBe(3);
    expect(m.storeCallsSaved).toBe(1);

    await remote.shutdown();
  });

  it('Express: remote increment is not called for shielded blocked requests', async () => {
    const remote = createRemoteLikeStore(100);
    const limiter = expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: remote,
      inMemoryBlock: 100,
      keyGenerator: () => 'k',
    });

    const app = express();
    app.use(limiter);
    app.get('/r', (_req, res) => res.status(200).json({ ok: true }));

    const total = 150;
    for (let i = 0; i < total; i++) {
      await request(app).get('/r');
    }

    expect(remote.increment).toHaveBeenCalledTimes(100);

    await remote.shutdown();
  });

  it('convenience shield() factory wraps a store', async () => {
    const inner = createRemoteLikeStore(10);
    const s = shield(inner, { blockOnConsumed: 10, blockDurationMs: 60_000 });
    expect(s).toBeInstanceOf(InMemoryShield);
    await s.shutdown();
  });

  it('Fastify decorates rateLimitShield', async () => {
    const remote = createRemoteLikeStore(10);
    const app = Fastify();
    await app.register(fastifyRateLimiter, {
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      store: remote,
      inMemoryBlock: 10,
    });
    expect(app.rateLimitShield).toBeInstanceOf(InMemoryShield);
    await app.close();
    await remote.shutdown();
  });
});
