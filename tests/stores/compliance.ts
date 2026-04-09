import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedWindowBoundaryMs } from '../../src/stores/dynamo/sliding-weighted.js';
import type { RateLimitResult, RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

/** Config passed to {@link StoreTestHarness.createStore} (window vs token bucket). */
export type StoreComplianceConfig =
  | {
      strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
      windowMs: number;
      maxRequests: number;
    }
  | {
      strategy: RateLimitStrategy.TOKEN_BUCKET;
      windowMs?: number;
      maxRequests?: number;
      tokensPerInterval: number;
      interval: number;
      bucketSize: number;
    };

export interface StoreTestHarness {
  name: string;
  createStore(config: StoreComplianceConfig): Promise<RateLimitStore>;
  afterEach?(): Promise<void>;
  afterAll?(): Promise<void>;
  /**
   * When set (e.g. {@link DynamoStore}'s weighted sliding window), sliding-window **numeric** expectations
   * allow up to this **relative** error (0.1 = 10%). Exact stores (Memory, Redis, PgStore, MongoStore) omit this.
   */
  slidingWindowTolerance?: number;
  /**
   * When true, skip fake timers and use real delays. Required for stores whose underlying client
   * (e.g. AWS SDK) has internal timers that don't respect vi.useFakeTimers().
   */
  useRealTimers?: boolean;
}

function expectWindowQuota(r: RateLimitResult, cap: number): void {
  if (r.isBlocked) {
    expect(r.remaining).toBe(0);
    expect(r.totalHits).toBeGreaterThan(cap);
  } else {
    expect(r.totalHits).toBeLessThanOrEqual(cap);
    expect(r.remaining).toBe(Math.max(0, cap - r.totalHits));
  }
}

/** Sliding-window count assertions: exact `toBe` unless harness.slidingWindowTolerance allows relative slack. */
function expectSlidingCount(
  harness: StoreTestHarness,
  actual: number,
  expected: number,
): void {
  const tol = harness.slidingWindowTolerance;
  if (tol === undefined || tol <= 0) {
    expect(actual).toBe(expected);
    return;
  }
  const scale = Math.max(1, Math.abs(expected));
  const maxDelta = Math.max(1, tol * scale);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(maxDelta);
}

export function runStoreComplianceTests(harness: StoreTestHarness): void {
  describe(`${harness.name} — store compliance`, () => {
    beforeEach(() => {
      if (!harness.useRealTimers) {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      }
    });

    afterEach(async () => {
      await harness.afterEach?.();
      if (!harness.useRealTimers) {
        vi.useRealTimers();
      }
    });

    afterAll(async () => {
      await harness.afterAll?.();
    });

    describe('fixed window', () => {
      it('increments, blocks when over cap, resets after window expiry', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 1000,
          maxRequests: 2,
        });
        try {
          const r1 = await store.increment('fw');
          const r2 = await store.increment('fw');
          const r3 = await store.increment('fw');
          expect(r1.isBlocked).toBe(false);
          expect(r2.isBlocked).toBe(false);
          expect(r3.isBlocked).toBe(true);
          expectWindowQuota(r3, 2);

          if (harness.useRealTimers) {
            await new Promise((r) => setTimeout(r, 1100));
          } else {
            vi.advanceTimersByTime(1001);
          }
          const r4 = await store.increment('fw');
          expect(r4.isBlocked).toBe(false);
          expect(r4.totalHits).toBe(1);
        } finally {
          await store.shutdown();
        }
      });

      it('decrement removes counted units (FIFO cap recovery)', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 5,
        });
        try {
          await store.increment('fd', { cost: 3 });
          await store.decrement('fd', { cost: 2 });
          const r = await store.increment('fd');
          expect(r.isBlocked).toBe(false);
          expect(r.totalHits).toBe(2);
        } finally {
          await store.shutdown();
        }
      });

      it('reset clears usage for the key', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 1000,
          maxRequests: 2,
        });
        try {
          await store.increment('x');
          await store.increment('x');
          await store.reset('x');
          const r = await store.increment('x');
          expect(r.totalHits).toBe(1);
          expect(r.isBlocked).toBe(false);
        } finally {
          await store.shutdown();
        }
      });

      it('honors per-increment maxRequests override', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 100,
        });
        try {
          const a = await store.increment('ov', { maxRequests: 2 });
          const b = await store.increment('ov', { maxRequests: 2 });
          const c = await store.increment('ov', { maxRequests: 2 });
          expect(a.isBlocked).toBe(false);
          expect(b.isBlocked).toBe(false);
          expect(c.isBlocked).toBe(true);
          expect(c.totalHits).toBe(3);
        } finally {
          await store.shutdown();
        }
      });

      it('applies cost > 1 on increment', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 1000,
          maxRequests: 10,
        });
        try {
          const r = await store.increment('fwc', { cost: 7 });
          expect(r.isBlocked).toBe(false);
          expect(r.totalHits).toBe(7);
          const blocked = await store.increment('fwc', { cost: 4 });
          expect(blocked.isBlocked).toBe(true);
        } finally {
          await store.shutdown();
        }
      });

      it('concurrent increments respect cap (linearizable totals)', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 50,
        });
        try {
          const results = await Promise.all(
            Array.from({ length: 100 }, () => store.increment('fw-conc')),
          );
          const blockedCount = results.filter((r) => r.isBlocked).length;
          const maxTotalHits = Math.max(...results.map((r) => r.totalHits));
          expect(blockedCount).toBe(50);
          expect(maxTotalHits).toBe(100);
        } finally {
          await store.shutdown();
        }
      });
    });

    describe('sliding window', () => {
      it('smooths bursts at window boundaries (no spike past rolling cap)', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 1000,
          maxRequests: 2,
        });
        try {
          /** Wall-clock anchor so real-time waits match fake `advanceTimersByTime(999)` from the same logical start. */
          const anchor = Date.now();
          await store.increment('sm', { cost: 1 });
          await store.increment('sm', { cost: 1 });
          if (harness.useRealTimers) {
            const elapsed = Date.now() - anchor;
            await new Promise((r) => setTimeout(r, Math.max(0, 999 - elapsed)));
          } else {
            vi.advanceTimersByTime(999);
          }
          const edge = await store.increment('sm');
          expect(edge.isBlocked).toBe(true);
        } finally {
          await store.shutdown();
        }
      });

      it('drops aged hits so quota recovers without a full wall-clock window gap', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 1000,
          maxRequests: 3,
        });
        try {
          const anchor = Date.now();
          await store.increment('age');
          await store.increment('age');
          await store.increment('age');
          const blocked = await store.increment('age');
          expect(blocked.isBlocked).toBe(true);

          if (harness.useRealTimers) {
            const elapsed = Date.now() - anchor;
            await new Promise((r) => setTimeout(r, Math.max(0, 1001 - elapsed)));
          } else {
            vi.advanceTimersByTime(1001);
          }
          const fresh = await store.increment('age');
          expect(fresh.isBlocked).toBe(false);
          expectSlidingCount(harness, fresh.totalHits, 1);
        } finally {
          await store.shutdown();
        }
      });

      it('applies cost > 1 atomically (weighted sliding units)', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 1000,
          maxRequests: 5,
        });
        try {
          const a = await store.increment('w', { cost: 2 });
          const b = await store.increment('w', { cost: 2 });
          const c = await store.increment('w', { cost: 2 });
          expectSlidingCount(harness, a.totalHits, 2);
          expectSlidingCount(harness, b.totalHits, 4);
          expect(c.isBlocked).toBe(true);
          expectSlidingCount(harness, c.totalHits, 6);

          await store.decrement('w', { cost: 2 });
          const d = await store.increment('w', { cost: 1 });
          expect(d.isBlocked).toBe(false);
          expectSlidingCount(harness, d.totalHits, 5);
        } finally {
          await store.shutdown();
        }
      });

      it('concurrent increments respect cap', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 50,
        });
        try {
          const results = await Promise.all(
            Array.from({ length: 100 }, () => store.increment('sw-conc')),
          );
          expectSlidingCount(harness, results.filter((r) => r.isBlocked).length, 50);
          expectSlidingCount(harness, Math.max(...results.map((r) => r.totalHits)), 100);
        } finally {
          await store.shutdown();
        }
      });
    });

    describe('token bucket', () => {
      it('refills tokens on interval and allows consume after refill', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 2,
          interval: 1000,
          bucketSize: 2,
        });
        try {
          const r1 = await store.increment('tb');
          const r2 = await store.increment('tb');
          const r3 = await store.increment('tb');
          expect(r1.isBlocked).toBe(false);
          expect(r2.isBlocked).toBe(false);
          expect(r3.isBlocked).toBe(true);

          if (harness.useRealTimers) {
            await new Promise((r) => setTimeout(r, 1100));
          } else {
            vi.advanceTimersByTime(1000);
          }
          const r4 = await store.increment('tb');
          expect(r4.isBlocked).toBe(false);
          expect(r4.remaining).toBe(1);
        } finally {
          await store.shutdown();
        }
      });

      it('respects burst capacity (bucketSize)', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 10,
          interval: 1000,
          bucketSize: 3,
        });
        try {
          const a = await store.increment('burst');
          const b = await store.increment('burst');
          const c = await store.increment('burst');
          expect(a.isBlocked && b.isBlocked && c.isBlocked).toBe(false);
          const d = await store.increment('burst');
          expect(d.isBlocked).toBe(true);
        } finally {
          await store.shutdown();
        }
      });

      it('applies cost > 1', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 10,
          interval: 1000,
          bucketSize: 10,
        });
        try {
          const r1 = await store.increment('tbw', { cost: 6 });
          expect(r1.isBlocked).toBe(false);
          expect(r1.remaining).toBe(4);
          const r2 = await store.increment('tbw', { cost: 5 });
          expect(r2.isBlocked).toBe(true);
        } finally {
          await store.shutdown();
        }
      });

      it('blocks when the bucket cannot pay cost', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 1,
          interval: 1000,
          bucketSize: 1,
        });
        try {
          const a = await store.increment('empty');
          expect(a.isBlocked).toBe(false);
          const b = await store.increment('empty');
          expect(b.isBlocked).toBe(true);
          expect(b.remaining).toBe(0);
        } finally {
          await store.shutdown();
        }
      });

      it('refills over wall-clock time', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 5,
          interval: 500,
          bucketSize: 5,
        });
        try {
          await store.increment('rf', { cost: 5 });
          const blocked = await store.increment('rf');
          expect(blocked.isBlocked).toBe(true);
          if (harness.useRealTimers) {
            await new Promise((r) => setTimeout(r, 600));
          } else {
            vi.advanceTimersByTime(500);
          }
          const ok = await store.increment('rf');
          expect(ok.isBlocked).toBe(false);
        } finally {
          await store.shutdown();
        }
      });
    });

    describe('cross-strategy: get / set / delete, resetAll, shutdown, concurrency', () => {
      it('get / set / delete round-trip when supported', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        });
        try {
          if (!store.get || !store.set || !store.delete) {
            return;
          }
          await store.increment('k');
          await store.increment('k');
          let g = await store.get('k');
          expect(g).not.toBeNull();
          expectSlidingCount(harness, g!.totalHits, 2);

          await store.set('k', 9);
          g = await store.get('k');
          expect(g).not.toBeNull();
          expectSlidingCount(harness, g!.totalHits, 9);

          expect(await store.delete('k')).toBe(true);
          await expect(store.get('k')).resolves.toBeNull();
          expect(await store.delete('missing')).toBe(false);
        } finally {
          await store.shutdown();
        }
      });

      it('resetAll clears observable state when implemented', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        });
        try {
          if (typeof store.resetAll !== 'function') {
            return;
          }
          await store.increment('a');
          await store.increment('b');
          store.resetAll();
          if (store.getActiveKeys) {
            expect(store.getActiveKeys().size).toBe(0);
          }
          const after = await store.increment('z');
          expectSlidingCount(harness, after.totalHits, 1);
        } finally {
          await store.shutdown();
        }
      });

      it('50 concurrent writers to one key yield expected blocked count and max totalHits', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 25,
        });
        try {
          const n = 50;
          const results = await Promise.all(
            Array.from({ length: n }, () => store.increment('fifty')),
          );
          const blocked = results.filter((r) => r.isBlocked).length;
          const maxHits = Math.max(...results.map((r) => r.totalHits));
          expectSlidingCount(harness, blocked, 25);
          expectSlidingCount(harness, maxHits, 50);
        } finally {
          await store.shutdown();
        }
      });
    });

    describe('isBlocked / remaining contract', () => {
      it('window strategies: block only when totalHits exceeds cap; remaining matches cap − usage', async () => {
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 1000,
          maxRequests: 3,
        });
        try {
          const rAtCap = await store.increment('cap', { cost: 3 });
          expect(rAtCap.totalHits).toBe(3);
          expect(rAtCap.isBlocked).toBe(false);
          expect(rAtCap.remaining).toBe(0);

          const rOver = await store.increment('cap', { cost: 1 });
          expect(rOver.isBlocked).toBe(true);
          expectWindowQuota(rOver, 3);
        } finally {
          await store.shutdown();
        }
      });

      it('token bucket: blocked implies remaining 0 and full-bucket totalHits', async () => {
        const bucketSize = 4;
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 1,
          interval: 1000,
          bucketSize,
        });
        try {
          for (let i = 0; i < bucketSize; i++) {
            await store.increment('tb-contract');
          }
          const blocked = await store.increment('tb-contract');
          expect(blocked.isBlocked).toBe(true);
          expect(blocked.remaining).toBe(0);
          expect(blocked.totalHits).toBe(bucketSize);
        } finally {
          await store.shutdown();
        }
      });
    });

    describe('resetTime contract', () => {
      it('allowed window increments: resetTime is in the future and matches window boundary', async () => {
        const windowMs = 1000;
        const store = await harness.createStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs,
          maxRequests: 10,
        });
        try {
          const t0 = Date.now();
          const r = await store.increment('rt');
          expect(r.resetTime.getTime()).toBeGreaterThan(t0);
          if (harness.useRealTimers) {
            /** {@link DynamoStore} uses {@link fixedWindowBoundaryMs} for sub-windows, not `t0 + windowMs`. */
            const b = fixedWindowBoundaryMs(t0, windowMs);
            expect(r.resetTime.getTime()).toBe(b + windowMs);
          } else {
            expect(r.resetTime.getTime()).toBe(t0 + windowMs);
          }
        } finally {
          await store.shutdown();
        }
      });

      it('allowed fixed-window increment: resetTime aligns with slice expiry', async () => {
        const windowMs = 1000;
        const store = await harness.createStore({
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs,
          maxRequests: 10,
        });
        try {
          const t0 = Date.now();
          const r = await store.increment('rt-fw');
          expect(r.resetTime.getTime()).toBeGreaterThan(t0);
          if (harness.useRealTimers) {
            const b = fixedWindowBoundaryMs(t0, windowMs);
            expect(r.resetTime.getTime()).toBe(b + windowMs);
          } else {
            expect(r.resetTime.getTime()).toBe(t0 + windowMs);
          }
        } finally {
          await store.shutdown();
        }
      });

      it('token bucket: resetTime is next tick after allowed consume', async () => {
        const interval = 1000;
        const store = await harness.createStore({
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 2,
          interval,
          bucketSize: 4,
        });
        try {
          const t0 = Date.now();
          const r = await store.increment('rt-tb');
          expect(r.isBlocked).toBe(false);
          expect(r.resetTime.getTime()).toBeGreaterThanOrEqual(t0);
        } finally {
          await store.shutdown();
        }
      });
    });
  });
}
