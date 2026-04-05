import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/composition/compose.js';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import type { RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const stores: Array<MemoryStore | ComposedStore> = [];

function track<T extends MemoryStore | ComposedStore>(s: T): T {
  stores.push(s);
  return s;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

function createApp(store: RateLimitStore, key: string) {
  const app = express();
  app.use(
    expressRateLimiter({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 10,
      standardHeaders: false,
      store,
      keyGenerator: () => key,
    }),
  );
  app.get('/ok', (req, res) => {
    res.status(200).json({
      ok: true,
      decidingLayer: (req as express.Request & { rateLimitComposed?: { decidingLayer?: string } })
        .rateLimitComposed?.decidingLayer,
    });
  });
  return app;
}

describe('composition integration (Express + supertest)', () => {
  describe('Scenario 1 — multi-window (compose.windows 10/sec + 100/min)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    });

    it('per-second then per-minute caps with fake timers', async () => {
      const store = track(
        compose.windows(
          { windowMs: 1000, maxRequests: 10 },
          { windowMs: 60_000, maxRequests: 100 },
        ),
      );
      const app = createApp(store, 'scenario-1');

      for (let i = 0; i < 10; i++) {
        expect((await request(app).get('/ok')).status).toBe(200);
      }
      expect((await request(app).get('/ok')).status).toBe(429);

      await vi.advanceTimersByTimeAsync(1000);

      expect((await request(app).get('/ok')).status).toBe(200);

      for (let j = 0; j < 9; j++) {
        expect((await request(app).get('/ok')).status).toBe(200);
      }
      await vi.advanceTimersByTimeAsync(1000);

      for (let chunk = 0; chunk < 8; chunk++) {
        for (let j = 0; j < 10; j++) {
          expect((await request(app).get('/ok')).status).toBe(200);
        }
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect((await request(app).get('/ok')).status).toBe(429);
    });
  });

  describe('Scenario 2 — compose.withBurst (steady + burst pool)', () => {
    it('exhausts steady then burst, then blocks', async () => {
      const store = track(
        compose.withBurst({
          steady: { windowMs: 1000, maxRequests: 2 },
          burst: { windowMs: 10_000, maxRequests: 5 },
        }),
      );
      const app = createApp(store, 'scenario-2');

      expect((await request(app).get('/ok')).status).toBe(200);
      expect((await request(app).get('/ok')).status).toBe(200);
      expect((await request(app).get('/ok')).status).toBe(200);
      for (let i = 0; i < 4; i++) {
        expect((await request(app).get('/ok')).status).toBe(200);
      }
      expect((await request(app).get('/ok')).status).toBe(429);
    });
  });

  describe('Scenario 3 — compose.firstAvailable failover', () => {
    it('uses healthy layer when first increment throws', async () => {
      const failing: RateLimitStore = {
        increment: async () => {
          throw new Error('redis down');
        },
        decrement: async () => {},
        reset: async () => {},
        shutdown: async () => {},
      };

      const healthy = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 100,
        }),
      );

      const store = track(
        compose.firstAvailable(compose.layer('failing', failing), compose.layer('healthy', healthy)),
      );
      const app = createApp(store, 'scenario-3');

      const r1 = await request(app).get('/ok');
      expect(r1.status).toBe(200);
      expect(r1.body.decidingLayer).toBe('healthy');

      const r2 = await request(app).get('/ok');
      expect(r2.status).toBe(200);
      expect(r2.body.decidingLayer).toBe('healthy');
    });
  });

  describe('Scenario 4 — nested: overflow inside all', () => {
    it('enforces overflow stack and hour cap independently', async () => {
      const steady = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 1000,
          maxRequests: 2,
        }),
      );
      const burst = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 10_000,
          maxRequests: 5,
        }),
      );
      const rate = track(
        compose.overflow(compose.layer('steady', steady), compose.layer('burst', burst)),
      );

      const hourCap = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 3_600_000,
          maxRequests: 1000,
        }),
      );

      const store = track(
        compose.all(compose.layer('rate', rate), compose.layer('hourCap', hourCap)),
      );
      const app = createApp(store, 'scenario-4a');

      for (let i = 0; i < 7; i++) {
        expect((await request(app).get('/ok')).status).toBe(200);
      }
      expect((await request(app).get('/ok')).status).toBe(429);

      const steady2 = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 1000,
          maxRequests: 100,
        }),
      );
      const burst2 = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 10_000,
          maxRequests: 100,
        }),
      );
      const rate2 = track(
        compose.overflow(compose.layer('steady', steady2), compose.layer('burst', burst2)),
      );
      const hourCapTight = track(
        new MemoryStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 3_600_000,
          maxRequests: 5,
        }),
      );
      const storeB = track(
        compose.all(compose.layer('rate', rate2), compose.layer('hourCap', hourCapTight)),
      );
      const appB = createApp(storeB, 'scenario-4b');

      for (let i = 0; i < 5; i++) {
        expect((await request(appB).get('/ok')).status).toBe(200);
      }
      expect((await request(appB).get('/ok')).status).toBe(429);
    });
  });

  describe('Scenario 5 — limits array vs compose.windows', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-07-01T08:00:00.000Z'));
    });

    it(
      'matches composed windows for the same traffic',
      async () => {
      const mergedLimits = mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        limits: [
          { windowMs: 1000, max: 10 },
          { windowMs: 60_000, max: 100 },
        ],
      });
      const mergedCompose = mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
        store: compose.windows(
          { windowMs: 1000, maxRequests: 10 },
          { windowMs: 60_000, maxRequests: 100 },
        ),
      });
      track(mergedLimits.store as ComposedStore);
      track(mergedCompose.store as ComposedStore);

      const appLimits = express();
      appLimits.use(
        expressRateLimiter({
          strategy: mergedLimits.strategy,
          windowMs: mergedLimits.windowMs,
          maxRequests: mergedLimits.maxRequests,
          store: mergedLimits.store,
          standardHeaders: false,
          keyGenerator: () => 'compat',
        }),
      );
      appLimits.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

      const appCompose = express();
      appCompose.use(
        expressRateLimiter({
          strategy: mergedCompose.strategy,
          windowMs: mergedCompose.windowMs,
          maxRequests: mergedCompose.maxRequests,
          store: mergedCompose.store,
          standardHeaders: false,
          keyGenerator: () => 'compat',
        }),
      );
      appCompose.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

      const seq: number[] = [];

      for (let i = 0; i < 10; i++) {
        seq.push((await request(appLimits).get('/ok')).status);
      }
      seq.push((await request(appLimits).get('/ok')).status);
      await vi.advanceTimersByTimeAsync(1000);
      seq.push((await request(appLimits).get('/ok')).status);
      for (let j = 0; j < 9; j++) {
        seq.push((await request(appLimits).get('/ok')).status);
      }
      await vi.advanceTimersByTimeAsync(1000);
      for (let chunk = 0; chunk < 8; chunk++) {
        for (let j = 0; j < 10; j++) {
          seq.push((await request(appLimits).get('/ok')).status);
        }
        await vi.advanceTimersByTimeAsync(1000);
      }
      seq.push((await request(appLimits).get('/ok')).status);

      const seq2: number[] = [];
      for (let i = 0; i < 10; i++) {
        seq2.push((await request(appCompose).get('/ok')).status);
      }
      seq2.push((await request(appCompose).get('/ok')).status);
      await vi.advanceTimersByTimeAsync(1000);
      seq2.push((await request(appCompose).get('/ok')).status);
      for (let j = 0; j < 9; j++) {
        seq2.push((await request(appCompose).get('/ok')).status);
      }
      await vi.advanceTimersByTimeAsync(1000);
      for (let chunk = 0; chunk < 8; chunk++) {
        for (let j = 0; j < 10; j++) {
          seq2.push((await request(appCompose).get('/ok')).status);
        }
        await vi.advanceTimersByTimeAsync(1000);
      }
      seq2.push((await request(appCompose).get('/ok')).status);

      expect(seq2).toEqual(seq);
      expect(seq).toEqual([
        ...Array(10).fill(200),
        429,
        200,
        ...Array(89).fill(200),
        429,
      ]);
      },
      60_000,
    );
  });
});
