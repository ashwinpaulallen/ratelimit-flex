/**
 * {@link PgStore} runs the shared {@link runStoreComplianceTests} suite against real Postgres.
 * Requires `TEST_POSTGRES_URL`, `PG_TEST_URL`, or `PG_STORE_TEST=1` (Testcontainers in CI).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgStore, pgStoreSchema } from '../../src/stores/postgres/index.js';
import type { PgClientLike } from '../../src/stores/postgres/types.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { runStoreComplianceTests } from './compliance.js';
import type { StoreComplianceConfig } from './compliance.js';
import {
  attachPgPoolTestErrorHandler,
  initPgStoreTestBackend,
  runPgStoreIntegration,
} from './pg-test-backend.js';

describe.skipIf(!runPgStoreIntegration)(
  'PgStore',
  { timeout: 180_000 },
  () => {
    let pool: Pool | undefined;
    let connectionUri: string | undefined;
    let cleanup: () => Promise<void> = async () => {};

    beforeAll(async () => {
      const backend = await initPgStoreTestBackend();
      pool = backend.pool;
      cleanup = backend.cleanup;
      connectionUri = backend.connectionUri;
    }, 120_000);

    afterAll(async () => {
      try {
        if (pool) {
          await pool.query('DROP TABLE IF EXISTS rate_limits');
        }
      } catch {
        /* pool may already be unusable */
      }
      await cleanup();
    });

    runStoreComplianceTests({
      name: 'PgStore',
      async createStore(config: StoreComplianceConfig) {
        if (config.strategy === RateLimitStrategy.TOKEN_BUCKET) {
          return new PgStore({
            client: pool!,
            strategy: RateLimitStrategy.TOKEN_BUCKET,
            tokensPerInterval: config.tokensPerInterval,
            interval: config.interval,
            bucketSize: config.bucketSize,
            autoSweepIntervalMs: 0,
          });
        }
        return new PgStore({
          client: pool!,
          strategy: config.strategy,
          windowMs: config.windowMs,
          maxRequests: config.maxRequests,
          autoSweepIntervalMs: 0,
        });
      },
      async afterEach() {
        await pool!.query('TRUNCATE TABLE rate_limits');
      },
    });

    describe('PgStore-specific', () => {
      it('fail-open: broken client allows traffic and sets storeUnavailable', async () => {
        const broken: PgClientLike = {
          query: async () => {
            throw new Error('connection refused');
          },
          connect: async () => ({
            query: async () => {
              throw new Error('connection refused');
            },
            release: () => {},
          }),
        };
        const store = new PgStore({
          client: broken,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          onPostgresError: 'fail-open',
          autoSweepIntervalMs: 0,
        });
        const r = await store.increment('k');
        expect(r.isBlocked).toBe(false);
        expect(r.storeUnavailable).toBe(true);
        expect(r.remaining).toBe(10);
        await store.shutdown();
      });

      it('fail-closed: broken client blocks and sets storeUnavailable', async () => {
        const broken: PgClientLike = {
          query: async () => {
            throw new Error('connection refused');
          },
          connect: async () => ({
            query: async () => {
              throw new Error('connection refused');
            },
            release: () => {},
          }),
        };
        const store = new PgStore({
          client: broken,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          onPostgresError: 'fail-closed',
          autoSweepIntervalMs: 0,
        });
        const r = await store.increment('k');
        expect(r.isBlocked).toBe(true);
        expect(r.storeUnavailable).toBe(true);
        expect(r.remaining).toBe(0);
        await store.shutdown();
      });

      it('sweep removes manually inserted expired rows', async () => {
        const store = new PgStore({
          client: pool!,
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          autoSweepIntervalMs: 0,
        });
        const sweepKey = `rlf:sweep-specific-${Date.now()}`;
        await pool!.query(
          `INSERT INTO rate_limits (key, total_hits, reset_at, hits, tokens, last_refill_at)
           VALUES ($1::text, 0, $2::timestamptz, NULL, NULL, NULL)`,
          [sweepKey, new Date('2017-01-01T00:00:00.000Z')],
        );
        const n = await store.sweep();
        expect(n).toBeGreaterThanOrEqual(1);
        const left = await pool!.query(`SELECT 1 FROM rate_limits WHERE key = $1::text`, [sweepKey]);
        expect(left.rows.length).toBe(0);
        await store.shutdown();
      });

      it('parameterized keys do not allow SQL injection', async () => {
        const evil = "'; DROP TABLE rate_limits; --";
        const store = new PgStore({
          client: pool!,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 5,
          autoSweepIntervalMs: 0,
        });
        await store.increment(evil);
        const t = await pool!.query<{ exists: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'rate_limits'
          ) AS exists`,
        );
        expect(t.rows[0]?.exists).toBe(true);
        await store.shutdown();
      });

      it('dead pool: subsequent increment follows onPostgresError (fail-open)', async () => {
        const { Pool } = await import('pg');
        const isolated = new Pool({ connectionString: connectionUri! });
        attachPgPoolTestErrorHandler(isolated);
        await isolated.query(pgStoreSchema);
        const store = new PgStore({
          client: isolated,
          strategy: RateLimitStrategy.FIXED_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
          onPostgresError: 'fail-open',
          autoSweepIntervalMs: 0,
        });
        const ok = await store.increment('dead-pool');
        expect(ok.storeUnavailable).toBeFalsy();
        await isolated.end();
        const dead = await store.increment('dead-pool');
        expect(dead.storeUnavailable).toBe(true);
        expect(dead.isBlocked).toBe(false);
        await store.shutdown();
      });
    });
  },
);
