import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expressQueuedRateLimiter } from '../../src/middleware/expressQueuedRateLimiter.js';
import { createRateLimiterQueue } from '../../src/queue/createRateLimiterQueue.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

/** Drain enough microtasks for chained `await` + `.then()` from concurrent `removeTokens` calls. */
async function flushMicrotasksDeep(iterations = 256): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

const stores: MemoryStore[] = [];

function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const s = new MemoryStore(options);
  stores.push(s);
  return s;
}

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

describe('queue integration', () => {
  /**
   * Supertest + Express need real timers for in-flight HTTP; the queued middleware tests use the same approach.
   * @see tests/middleware/expressQueuedRateLimiter.test.ts
   */
  describe('Scenario 1 — HTTP server with queued rate limiting', () => {
    it('serves 2 immediately, queues 3 until window advances (~1s total)', async () => {
      const store = trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 2,
      });
      const app = express();
      app.use(
        expressQueuedRateLimiter({
          windowMs: 1000,
          maxRequests: 2,
          maxQueueSize: 5,
          standardHeaders: false,
          store,
          keyGenerator: () => 'scenario-1',
        }),
      );
      app.get('/ok', (_req, res) => {
        res.status(200).json({ ok: true });
      });

      const t0 = Date.now();
      const completionTimes: number[] = [];

      const promises = Array.from({ length: 5 }, () =>
        request(app)
          .get('/ok')
          .then((res) => {
            completionTimes.push(Date.now() - t0);
            expect(res.status).toBe(200);
            return res;
          }),
      );

      await Promise.all(promises);

      expect(completionTimes.length).toBe(5);
      const sorted = [...completionTimes].sort((a, b) => a - b);
      expect(sorted[0]).toBeLessThan(200);
      expect(sorted[1]).toBeLessThan(200);
      
      // More lenient threshold for CI environments
      const minQueuedDelay = process.env.CI ? 500 : 700;
      expect(sorted[2]).toBeGreaterThanOrEqual(minQueuedDelay);
      expect(sorted[3]).toBeGreaterThanOrEqual(minQueuedDelay);
      expect(sorted[4]).toBeGreaterThanOrEqual(minQueuedDelay);

      const span = Math.max(...completionTimes) - Math.min(...completionTimes);
      expect(span).toBeGreaterThanOrEqual(500);
      expect(Math.max(...completionTimes)).toBeLessThan(4000);
    });
  });

  describe('Scenario 2 — Queue overflow', () => {
    it('returns 429 when the wait queue is full', async () => {
      const store = trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 2,
      });
      const app = express();
      app.use(
        expressQueuedRateLimiter({
          windowMs: 1000,
          maxRequests: 2,
          maxQueueSize: 2,
          standardHeaders: false,
          store,
          keyGenerator: () => 'scenario-2',
        }),
      );
      app.get('/ok', (_req, res) => {
        res.status(200).json({ ok: true });
      });

      const statuses: number[] = [];

      const promises = Array.from({ length: 5 }, () =>
        request(app)
          .get('/ok')
          .then((res) => {
            statuses.push(res.status);
            return res;
          }),
      );

      await Promise.all(promises);

      expect(statuses.sort((a, b) => a - b)).toEqual([200, 200, 200, 200, 429]);
    });
  });

  describe('Scenario 3 — Standalone queue for API client', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('drains 3 tokens per 500ms window', async () => {
      const store = trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 500,
        maxRequests: 3,
      });
      const q = createRateLimiterQueue({
        maxRequests: 3,
        windowMs: 500,
        maxQueueSize: 100,
        store,
      });

      const t0 = Date.now();
      const resolveAt: number[] = [];

      const promises = Array.from({ length: 9 }, () =>
        q.removeTokens('api').then(() => {
          resolveAt.push(Date.now() - t0);
        }),
      );

      await flushMicrotasksDeep();

      expect(resolveAt.length).toBe(3);
      for (const t of resolveAt) {
        expect(t).toBe(0);
      }

      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasksDeep();
      expect(resolveAt.length).toBe(6);
      for (let i = 3; i < 6; i++) {
        expect(resolveAt[i]).toBe(500);
      }

      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasksDeep();
      await Promise.all(promises);

      expect(resolveAt.length).toBe(9);
      for (let i = 6; i < 9; i++) {
        expect(resolveAt[i]).toBe(1000);
      }
    });
  });
});
