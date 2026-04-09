/**
 * Postgres integration tests for {@link PgStore}.
 *
 * Runs when any of:
 * - `PG_STORE_TEST=1` — Testcontainers + Docker (set in CI workflow)
 * - `PG_TEST_URL` — use an existing server (no Testcontainers)
 *
 * Skipped otherwise (fast local `npm test`). This avoids pg-mem: it does not
 * implement enough of Postgres (e.g. timestamptz parameter binding) to trust
 * for these queries — use a real instance in CI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgStore } from '../../src/stores/postgres/PgStore.js';
import type { PgClientLike } from '../../src/stores/postgres/types.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { initPgStoreTestBackend, runPgStoreIntegration } from './pg-test-backend.js';

describe.skipIf(!runPgStoreIntegration)(
  'PgStore integration (fixed window + token bucket + sliding)',
  { timeout: 180_000 },
  () => {
    let client!: PgClientLike;
    let pool!: Pool;
    let cleanup: () => Promise<void> = async () => {};

    beforeAll(async () => {
      try {
        const backend = await initPgStoreTestBackend();
        client = backend.client;
        pool = backend.pool;
        cleanup = backend.cleanup;
        if (process.env.PG_TEST_URL) {
          console.info('[PgStore integration] Using PG_TEST_URL');
        } else {
          console.info('[PgStore integration] Using Testcontainers Postgres');
        }
      } catch (err) {
        console.warn(
          '[PgStore integration] Postgres unavailable (Docker or PG_TEST_URL?).',
          err,
        );
        throw err;
      }
    });

    afterAll(async () => {
      await cleanup();
    });

    describe('fixed window', () => {
      it('concurrent increments from 50 clients enforce cap 25', async () => {
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 25,
          autoSweepIntervalMs: 0,
        });
        const results = await Promise.all(
          Array.from({ length: 50 }, () => store.increment('conc-fixed')),
        );
        expect(results.filter((r) => r.isBlocked).length).toBe(25);
        expect(Math.max(...results.map((r) => r.totalHits))).toBe(50);
        await store.shutdown();
      });

      it('resets usage after the window expires (virtual clock)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 1000,
          maxRequests: 2,
          autoSweepIntervalMs: 0,
        });
        await store.increment('fw-exp');
        await store.increment('fw-exp');
        const c = await store.increment('fw-exp');
        expect(c.isBlocked).toBe(true);
        vi.advanceTimersByTime(1001);
        const d = await store.increment('fw-exp');
        expect(d.isBlocked).toBe(false);
        expect(d.totalHits).toBe(1);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('honors cost > 1', async () => {
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 10_000,
          maxRequests: 10,
          autoSweepIntervalMs: 0,
        });
        const r = await store.increment('cost-fw', { cost: 7 });
        expect(r.totalHits).toBe(7);
        const blocked = await store.increment('cost-fw', { cost: 4 });
        expect(blocked.isBlocked).toBe(true);
        await store.shutdown();
      });

      it('honors per-increment maxRequests override', async () => {
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 100,
          autoSweepIntervalMs: 0,
        });
        const a = await store.increment('ov', { maxRequests: 2 });
        const b = await store.increment('ov', { maxRequests: 2 });
        const c = await store.increment('ov', { maxRequests: 2 });
        expect(a.isBlocked).toBe(false);
        expect(b.isBlocked).toBe(false);
        expect(c.isBlocked).toBe(true);
        expect(c.totalHits).toBe(3);
        await store.shutdown();
      });
    });

    describe('token bucket', () => {
      it('refills tokens on interval (virtual clock)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: 2,
          interval: 1000,
          bucketSize: 2,
          autoSweepIntervalMs: 0,
        });
        await store.increment('tb-ref');
        await store.increment('tb-ref');
        const blocked = await store.increment('tb-ref');
        expect(blocked.isBlocked).toBe(true);
        vi.advanceTimersByTime(1000);
        const ok = await store.increment('tb-ref');
        expect(ok.isBlocked).toBe(false);
        expect(ok.remaining).toBe(1);
        await store.shutdown();
        vi.useRealTimers();
      });
    });

    describe('sliding window (JSONB hits)', () => {
      it('stores cost identical timestamps as multiset (jsonb length matches logical hits)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 10_000,
          maxRequests: 20,
          autoSweepIntervalMs: 0,
        });
        await store.increment('cost-multiset', { cost: 4 });
        const row = await client.query(
          `SELECT jsonb_array_length(hits) AS len, total_hits::text AS th
           FROM rate_limits WHERE key = $1::text`,
          ['rlf:cost-multiset'],
        );
        expect(Number(row.rows[0]!['len'])).toBe(4);
        expect(Number(row.rows[0]!['th'])).toBe(4);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('prunes expired entries on increment (array shrinks after window slides)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 1000,
          maxRequests: 10,
          autoSweepIntervalMs: 0,
        });
        await store.increment('prune-sw', { cost: 5 });
        let len = await client.query(
          `SELECT jsonb_array_length(hits) AS len FROM rate_limits WHERE key = $1::text`,
          ['rlf:prune-sw'],
        );
        expect(Number(len.rows[0]!['len'])).toBe(5);
        vi.advanceTimersByTime(1001);
        await store.increment('prune-sw');
        len = await client.query(
          `SELECT jsonb_array_length(hits) AS len FROM rate_limits WHERE key = $1::text`,
          ['rlf:prune-sw'],
        );
        expect(Number(len.rows[0]!['len'])).toBe(1);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('keeps jsonb payload bounded under steady sub-cap traffic (blocked hits still append)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-15T11:00:00.000Z'));
        const cap = 50;
        const windowMs = 5000;
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs,
          maxRequests: cap,
          autoSweepIntervalMs: 0,
        });
        // ~6.7 req/s → at most ~34 hits in a 5s window — stays under cap so array size tracks usage, not attack volume.
        for (let i = 0; i < 100; i++) {
          vi.advanceTimersByTime(150);
          await store.increment('steady');
          const r = await client.query(
            `SELECT jsonb_array_length(hits) AS len, total_hits::text AS th FROM rate_limits WHERE key = $1::text`,
            ['rlf:steady'],
          );
          const n = Number(r.rows[0]!['len']);
          const th = Number(r.rows[0]!['th']);
          expect(th).toBeLessThanOrEqual(cap);
          expect(n).toBe(th);
          expect(n).toBeLessThanOrEqual(40);
        }
        await store.shutdown();
        vi.useRealTimers();
      });

      it('concurrent increments match compliance expectations (50 blocked of 100)', async () => {
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 25,
          autoSweepIntervalMs: 0,
        });
        const results = await Promise.all(
          Array.from({ length: 50 }, () => store.increment('conc-sw')),
        );
        expect(results.filter((r) => r.isBlocked).length).toBe(25);
        expect(Math.max(...results.map((r) => r.totalHits))).toBe(50);
        await store.shutdown();
      });

      it('FIFO decrement removes oldest hits (array shortens from the front)', async () => {
        vi.useFakeTimers();
        const t0 = new Date('2026-07-01T12:00:00.000Z').getTime();
        vi.setSystemTime(new Date(t0));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 100,
          autoSweepIntervalMs: 0,
        });
        await store.increment('fifo', { cost: 1 });
        vi.advanceTimersByTime(1);
        await store.increment('fifo', { cost: 1 });
        vi.advanceTimersByTime(1);
        await store.increment('fifo', { cost: 1 });
        await store.decrement('fifo', { cost: 1 });
        const row = await client.query(
          `SELECT hits::text AS h FROM rate_limits WHERE key = $1::text`,
          ['rlf:fifo'],
        );
        const arr = JSON.parse(String(row.rows[0]!['h'])) as string[];
        expect(arr).toEqual([String(t0 + 1), String(t0 + 2)]);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('LIFO decrement (removeNewest) drops the newest multiset entries', async () => {
        vi.useFakeTimers();
        const t0 = new Date('2026-07-02T08:00:00.000Z').getTime();
        vi.setSystemTime(new Date(t0));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 100,
          autoSweepIntervalMs: 0,
        });
        await store.increment('lifo', { cost: 1 });
        vi.advanceTimersByTime(5);
        await store.increment('lifo', { cost: 1 });
        vi.advanceTimersByTime(5);
        await store.increment('lifo', { cost: 1 });
        await store.decrement('lifo', { cost: 1, removeNewest: true });
        const row = await client.query(
          `SELECT hits::text AS h FROM rate_limits WHERE key = $1::text`,
          ['rlf:lifo'],
        );
        const arr = JSON.parse(String(row.rows[0]!['h'])) as string[];
        expect(arr).toEqual([String(t0), String(t0 + 5)]);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('get uses live hit count from hits JSON, not a stale total_hits column', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 10_000,
          maxRequests: 50,
          autoSweepIntervalMs: 0,
        });
        await store.increment('stale', { cost: 3 });
        await client.query(
          `UPDATE rate_limits SET total_hits = 999 WHERE key = $1::text`,
          ['rlf:stale'],
        );
        const g = await store.get('stale');
        expect(g?.totalHits).toBe(3);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('concurrent decrement + increment keeps row consistent', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 100,
          autoSweepIntervalMs: 0,
        });
        await store.increment('mix', { cost: 5 });
        await Promise.all([
          store.decrement('mix', { cost: 2 }),
          store.increment('mix', { cost: 3 }),
        ]);
        const row = await client.query(
          `SELECT total_hits::text AS th,
                  jsonb_array_length(hits) AS jl
           FROM rate_limits WHERE key = $1::text`,
          ['rlf:mix'],
        );
        const th = Number(row.rows[0]!['th']);
        const jl = Number(row.rows[0]!['jl']);
        expect(th).toBe(jl);
        expect(th).toBe(6);
        await store.shutdown();
        vi.useRealTimers();
      });
    });

    describe('reset, delete, sweep, shutdown (Postgres)', () => {
      it('reset removes the row; get returns null', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          autoSweepIntervalMs: 0,
        });
        await store.increment('rk');
        await store.reset('rk');
        expect(await store.get('rk')).toBeNull();
        const n = await client.query(`SELECT count(*)::int AS c FROM rate_limits WHERE key = $1::text`, [
          'rlf:rk',
        ]);
        expect(Number(n.rows[0]!['c'])).toBe(0);
        await store.shutdown();
        vi.useRealTimers();
      });

      it('delete returns false when missing and true when a row existed', async () => {
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          autoSweepIntervalMs: 0,
        });
        expect(await store.delete('nope')).toBe(false);
        await store.increment('yes-del');
        expect(await store.delete('yes-del')).toBe(true);
        expect(await store.delete('yes-del')).toBe(false);
        await store.shutdown();
      });

      it('sweep deletes expired rows and returns count', async () => {
        const sweepKey = `rlf:sweep-me-${Date.now()}`;
        await client.query(
          `INSERT INTO rate_limits (key, total_hits, reset_at, hits, tokens, last_refill_at)
           VALUES ($1::text, 0, $2::timestamptz, NULL, NULL, NULL)`,
          [sweepKey, new Date('2018-01-01T00:00:00.000Z')],
        );
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          autoSweepIntervalMs: 0,
        });
        const n = await store.sweep();
        expect(n).toBeGreaterThanOrEqual(1);
        const left = await client.query(`SELECT 1 FROM rate_limits WHERE key = $1::text`, [sweepKey]);
        expect(left.rows.length).toBe(0);
        await store.shutdown();
      });

      it('shutdown leaves pg.Pool usable (does not end the pool)', async () => {
        await client.query(`DELETE FROM rate_limits WHERE key = $1::text`, ['rlf:shutdown-pool']);
        const store = new PgStore({
          client,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 5,
          autoSweepIntervalMs: 0,
        });
        await store.increment('shutdown-pool');
        await store.shutdown();
        await expect(pool.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
        await client.query(`DELETE FROM rate_limits WHERE key = $1::text`, ['rlf:shutdown-pool']);
      });
    });
  },
);
