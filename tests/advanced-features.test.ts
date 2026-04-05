import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposedStore } from '../src/composition/ComposedStore.js';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';
import { RateLimitEngine, createRateLimiter } from '../src/strategies/rate-limit-engine.js';
import { expressRateLimiter } from '../src/middleware/express.js';
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

function appWith(
  opts: Parameters<typeof expressRateLimiter>[0],
  path = '/ok',
  handler: express.RequestHandler = (_req, res) => res.status(200).json({ ok: true }),
) {
  const app = express();
  app.use(express.json());
  app.use(expressRateLimiter(opts));
  app.get(path, handler);
  return app;
}

describe('rate limit grouping (multiple windows)', () => {
  it('blocks when any window is exceeded', async () => {
    const app = appWith({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      limits: [
        { windowMs: 60_000, max: 2 },
        { windowMs: 60_000, max: 100 },
      ],
    });

    expect((await request(app).get('/ok')).status).toBe(200);
    expect((await request(app).get('/ok')).status).toBe(200);
    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(429);
  });

  it('blocks when the stricter second window is exceeded', async () => {
    const app = appWith({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      limits: [
        { windowMs: 60_000, max: 100 },
        { windowMs: 60_000, max: 1 },
      ],
    });

    expect((await request(app).get('/ok')).status).toBe(200);
    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(429);
  });
});

describe('dynamic maxRequests', () => {
  it('allows different limits per request via function', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: (req) =>
          (req as express.Request).header('x-tier') === 'premium' ? 10 : 1,
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    expect((await request(app).get('/ok')).status).toBe(200);
    expect((await request(app).get('/ok')).status).toBe(429);
    expect((await request(app).get('/ok').set('x-tier', 'premium')).status).toBe(200);
  });
});

describe('penalty box', () => {
  it('applies a temporary ban after repeated violations', async () => {
    const onPenalty = vi.fn();
    const app = appWith({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
      penaltyBox: {
        violationsThreshold: 2,
        violationWindowMs: 120_000,
        penaltyDurationMs: 30_000,
        onPenalty,
      },
    });

    expect((await request(app).get('/ok')).status).toBe(200);
    expect((await request(app).get('/ok')).status).toBe(429);
    expect((await request(app).get('/ok')).status).toBe(429);
    expect(onPenalty).toHaveBeenCalledTimes(1);

    const penalty = await request(app).get('/ok');
    expect(penalty.status).toBe(429);
    expect(penalty.body).toEqual({ error: 'Too many requests' });
  });

  it('prunes expired penalty map entries without each key revisiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const engine = new RateLimitEngine(
        mergeRateLimiterOptions({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
          penaltyBox: {
            violationsThreshold: 1,
            violationWindowMs: 60_000,
            penaltyDurationMs: 60_000,
          },
          store: trackedStore({
            strategy: RateLimitStrategy.SLIDING_WINDOW,
            windowMs: 60_000,
            maxRequests: 1,
          }),
        }),
      );
      const penaltyUntil = (engine as unknown as { penaltyUntil: Map<string, number> }).penaltyUntil;

      for (let i = 0; i < 2000; i++) {
        const k = `pen-${i}`;
        await engine.consumeWithKey(k, {});
        await engine.consumeWithKey(k, {});
      }
      expect(penaltyUntil.size).toBe(2000);

      vi.advanceTimersByTime(60_001);
      await engine.consumeWithKey('sweeper', {});
      expect(penaltyUntil.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('allowlist / blocklist', () => {
  it('skips limiting for allowlisted keys', async () => {
    const app = appWith({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator: (req) => String((req as express.Request).header('x-api-key') ?? 'none'),
      allowlist: ['vip'],
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });

    await request(app).get('/ok').set('x-api-key', 'a');
    expect((await request(app).get('/ok').set('x-api-key', 'a')).status).toBe(429);
    expect((await request(app).get('/ok').set('x-api-key', 'vip')).status).toBe(200);
    expect((await request(app).get('/ok').set('x-api-key', 'vip')).status).toBe(200);
  });

  it('rejects blocklisted keys immediately', async () => {
    const app = appWith({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      keyGenerator: (req) => String((req as express.Request).header('x-api-key') ?? 'none'),
      blocklist: ['bad'],
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      }),
    });

    const res = await request(app).get('/ok').set('x-api-key', 'bad');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });
});

describe('draft mode', () => {
  it('allows traffic but reports draftWouldBlock via engine', async () => {
    const onDraftViolation = vi.fn();
    const engine = createRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      draft: true,
      onDraftViolation,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });

    const r1 = await engine.consume('k1');
    expect(r1.isBlocked).toBe(false);
    expect(r1.draftWouldBlock).toBeUndefined();

    const r2 = await engine.consume('k1');
    expect(r2.isBlocked).toBe(false);
    expect(r2.draftWouldBlock).toBe(true);
    expect(onDraftViolation).toHaveBeenCalledTimes(1);

    const r3 = await engine.consume('k1');
    expect(r3.draftWouldBlock).toBe(true);
  });

  it('express middleware returns 200 when draft would block', async () => {
    const app = appWith({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 1,
      draft: true,
      store: trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
      }),
    });

    expect((await request(app).get('/ok')).status).toBe(200);
    expect((await request(app).get('/ok')).status).toBe(200);
  });

  it('draft + grouped windows rolls back every window touched (not only the blocking window)', async () => {
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      draft: true,
      limits: [
        { windowMs: 60_000, max: 100 },
        { windowMs: 60_000, max: 1 },
      ],
    });
    const composed = merged.store as ComposedStore;
    const innerStores = composed.layers.map((l) => l.store);
    const dec0 = vi.spyOn(innerStores[0]!, 'decrement');
    const dec1 = vi.spyOn(innerStores[1]!, 'decrement');
    const engine = new RateLimitEngine(merged);

    const first = await engine.consumeWithKey('draft-grouped', {});
    expect(first.isBlocked).toBe(false);
    expect(first.draftWouldBlock).toBeUndefined();
    expect(dec0).not.toHaveBeenCalled();
    expect(dec1).not.toHaveBeenCalled();

    const wouldBlock = await engine.consumeWithKey('draft-grouped', {});
    expect(wouldBlock.isBlocked).toBe(false);
    expect(wouldBlock.draftWouldBlock).toBe(true);
    // Stricter layer blocks: inner rollback of the successful layer + draft rollback on the blocking layer.
    expect(dec0).toHaveBeenCalledTimes(1);
    expect(dec1).toHaveBeenCalledTimes(1);

    await merged.store.shutdown();
  });
});

describe('RateLimitEngine blockReason', () => {
  it('sets blockReason for blocklist and penalty', async () => {
    const blockEngine = new RateLimitEngine(
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        blocklist: ['blocked'],
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      }),
    );
    const br = await blockEngine.consumeWithKey('blocked', {});
    expect(br.isBlocked).toBe(true);
    expect(br.blockReason).toBe('blocklist');

    const penaltyEngine = new RateLimitEngine(
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        penaltyBox: {
          violationsThreshold: 1,
          violationWindowMs: 60_000,
          penaltyDurationMs: 60_000,
        },
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      }),
    );
    await penaltyEngine.consumeWithKey('p', {});
    await penaltyEngine.consumeWithKey('p', {});
    const pr = await penaltyEngine.consumeWithKey('p', {});
    expect(pr.isBlocked).toBe(true);
    expect(pr.blockReason).toBe('penalty');
  });
});
