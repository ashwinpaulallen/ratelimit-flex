/**
 * {@link MongoStore}: shared compliance suite plus Mongo-specific checks.
 *
 * Set `TEST_MONGO_URL` to use an existing MongoDB; otherwise **mongodb-memory-server** is used.
 */
import type { Collection } from 'mongodb';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RateLimitDocument } from '../../src/stores/mongo/types.js';
import { MongoStore } from '../../src/stores/mongo/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { runStoreComplianceTests } from './compliance.js';
import type { StoreComplianceConfig } from './compliance.js';

const TEST_DB = 'test_rlf';
const RATE_LIMITS = 'rate_limits';

describe('MongoStore', { timeout: 300_000 }, () => {
  let client!: MongoClient;
  let mongod: MongoMemoryServer | undefined;

  beforeAll(async () => {
    let uri = process.env.TEST_MONGO_URL;
    if (!uri) {
      mongod = await MongoMemoryServer.create();
      uri = mongod.getUri();
    }
    client = new MongoClient(uri);
    await client.connect();
  });

  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  runStoreComplianceTests({
    name: 'MongoStore',
    async createStore(config: StoreComplianceConfig) {
      const mongo = { client, dbName: TEST_DB, collectionName: RATE_LIMITS };
      if (config.strategy === RateLimitStrategy.TOKEN_BUCKET) {
        return new MongoStore({
          mongo,
          strategy: RateLimitStrategy.TOKEN_BUCKET,
          tokensPerInterval: config.tokensPerInterval,
          interval: config.interval,
          bucketSize: config.bucketSize,
          ensureIndexes: false,
        });
      }
      return new MongoStore({
        mongo,
        strategy: config.strategy,
        windowMs: config.windowMs,
        maxRequests: config.maxRequests,
        ensureIndexes: false,
      });
    },
    async afterEach() {
      await client.db(TEST_DB).collection(RATE_LIMITS).deleteMany({});
    },
  });

  describe('MongoStore sliding-window specifics', () => {
    const slidingColl = 'mongo_sliding_extra';

    afterEach(async () => {
      const db = client.db(TEST_DB);
      await db.collection(slidingColl).deleteMany({});
      await db.collection('mongo_sliding_large').deleteMany({});
      vi.useRealTimers();
    });

    it('stores totalHits equal to hits array length (including multiset timestamps)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
      const db = client.db(TEST_DB);
      const store = new MongoStore({
        mongo: { db, collectionName: slidingColl },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 10_000,
        maxRequests: 20,
        ensureIndexes: false,
      });
      await store.increment('cost-multiset', { cost: 4 });
      const doc = await db.collection(slidingColl).findOne({ _id: 'rlf:cost-multiset' });
      expect(Array.isArray(doc?.hits)).toBe(true);
      expect(doc?.hits).toHaveLength(4);
      expect(doc?.totalHits).toBe(4);
      await store.shutdown();
    });

    it('prunes expired timestamps on increment (array shrinks when window slides)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
      const db = client.db(TEST_DB);
      const store = new MongoStore({
        mongo: { db, collectionName: slidingColl },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
        ensureIndexes: false,
      });
      await store.increment('prune-sw', { cost: 5 });
      let doc = await db.collection(slidingColl).findOne({ _id: 'rlf:prune-sw' });
      expect(doc?.hits).toHaveLength(5);
      vi.advanceTimersByTime(1001);
      await store.increment('prune-sw');
      doc = await db.collection(slidingColl).findOne({ _id: 'rlf:prune-sw' });
      expect(doc?.hits).toHaveLength(1);
      expect(doc?.totalHits).toBe(1);
      await store.shutdown();
    });

    /**
     * Large caps stress the BSON array append path. On a typical laptop against
     * mongodb-memory-server, a single increment with `cost: 1500` completes in
     * well under one second; the bound below avoids flakes on slow CI only.
     */
    it('sliding window: 1500 weighted units in one increment stays within latency budget', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-01T08:00:00.000Z'));
      const db = client.db(TEST_DB);
      const coll = db.collection('mongo_sliding_large');
      await coll.deleteMany({});
      const store = new MongoStore({
        mongo: { db, collectionName: 'mongo_sliding_large' },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 2000,
        ensureIndexes: false,
      });
      const t0 = performance.now();
      const r = await store.increment('big', { cost: 1500 });
      const elapsedMs = performance.now() - t0;
      expect(r.totalHits).toBe(1500);
      expect(r.isBlocked).toBe(false);
      const doc = await coll.findOne({ _id: 'rlf:big' });
      expect(doc?.hits).toHaveLength(1500);
      expect(doc?.totalHits).toBe(1500);
      expect(elapsedMs).toBeLessThan(15_000);
      await store.shutdown();
    });
  });

  describe('MongoStore get, set, decrement', () => {
    const apiColl = 'mongo_api';

    afterEach(async () => {
      await client.db(TEST_DB).collection(apiColl).deleteMany({});
      vi.useRealTimers();
    });

    it('get(sliding) uses a live cutoff (now − windowMs), not only stored totalHits', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
      const db = client.db(TEST_DB);
      const store = new MongoStore({
        mongo: { db, collectionName: apiColl },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
        ensureIndexes: false,
      });
      await store.increment('live');
      await store.increment('live');
      let g = await store.get('live');
      expect(g?.totalHits).toBe(2);
      vi.advanceTimersByTime(1001);
      g = await store.get('live');
      expect(g).toBeNull();
      await store.shutdown();
    });

    it('increment(sliding) resetTime is oldest hit + windowMs, not now + windowMs', async () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-08-15T14:00:00.000Z').getTime();
      const windowMs = 60_000;
      vi.setSystemTime(t0);
      const db = client.db(TEST_DB);
      const store = new MongoStore({
        mongo: { db, collectionName: apiColl },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs,
        maxRequests: 100,
        ensureIndexes: false,
      });
      await store.increment('hdr');
      vi.advanceTimersByTime(25_000);
      const r = await store.increment('hdr');
      expect(r.resetTime.getTime()).toBe(t0 + windowMs);
      expect(r.resetTime.getTime()).not.toBe(Date.now() + windowMs);
      await store.shutdown();
    });

    it('decrement(fixed) clamps totalHits at 0 via aggregation $max', async () => {
      const db = client.db(TEST_DB);
      const store = new MongoStore({
        mongo: { db, collectionName: apiColl },
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        ensureIndexes: false,
      });
      await store.increment('clamp', { cost: 2 });
      await store.decrement('clamp', { cost: 100 });
      const doc = await db.collection(apiColl).findOne({ _id: 'rlf:clamp' });
      expect(doc?.totalHits).toBe(0);
      await store.shutdown();
    });

    it('set(sliding) replaceOne+upsert writes hits length === totalHits (uniform timestamps)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T09:00:00.000Z'));
      const db = client.db(TEST_DB);
      const store = new MongoStore({
        mongo: { db, collectionName: apiColl },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
        ensureIndexes: false,
      });
      await store.set('prog', 7);
      const doc = await db.collection(apiColl).findOne({ _id: 'rlf:prog' });
      expect(doc?.hits).toHaveLength(7);
      expect(doc?.totalHits).toBe(7);
      expect(new Set(doc?.hits as number[]).size).toBe(1);
      await store.shutdown();
    });

    it('decrement(sliding) FIFO drops oldest hits; LIFO (removeNewest) drops from the end', async () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-07-01T12:00:00.000Z').getTime();
      vi.setSystemTime(new Date(t0));
      const db = client.db(TEST_DB);
      const coll = db.collection(apiColl);
      const store = new MongoStore({
        mongo: { db, collectionName: apiColl },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
        ensureIndexes: false,
      });
      await store.increment('fifo', { cost: 1 });
      vi.advanceTimersByTime(1);
      await store.increment('fifo', { cost: 1 });
      vi.advanceTimersByTime(1);
      await store.increment('fifo', { cost: 1 });
      await store.decrement('fifo', { cost: 1 });
      let doc = await coll.findOne({ _id: 'rlf:fifo' });
      expect(doc?.hits).toEqual([t0 + 1, t0 + 2]);

      await coll.deleteMany({});
      vi.setSystemTime(new Date(t0));
      await store.increment('lifo', { cost: 1 });
      vi.advanceTimersByTime(1);
      await store.increment('lifo', { cost: 1 });
      vi.advanceTimersByTime(1);
      await store.increment('lifo', { cost: 1 });
      await store.decrement('lifo', { cost: 1, removeNewest: true });
      doc = await coll.findOne({ _id: 'rlf:lifo' });
      expect(doc?.hits).toEqual([t0, t0 + 1]);
      await store.shutdown();
    });
  });

  describe('handleError when Mongo operations fail', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('token bucket uses refill interval (interval), not windowMs, for resetTime', async () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-06-01T10:00:00.000Z').getTime();
      vi.setSystemTime(t0);
      const brokenCollection = {
        findOneAndUpdate: vi.fn().mockRejectedValue(new Error('connection refused')),
      } as unknown as Collection<RateLimitDocument>;
      const store = new MongoStore({
        mongo: { collection: brokenCollection },
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        windowMs: 60_000,
        interval: 5_000,
        tokensPerInterval: 1,
        bucketSize: 10,
        ensureIndexes: false,
        onMongoError: 'fail-open',
      });
      const r = await store.increment('k');
      expect(r.storeUnavailable).toBe(true);
      expect(r.resetTime.getTime()).toBe(t0 + 5_000);
      await store.shutdown();
    });

    it('sliding window uses windowMs for resetTime', async () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-06-01T10:00:00.000Z').getTime();
      vi.setSystemTime(t0);
      const brokenCollection = {
        findOneAndUpdate: vi.fn().mockRejectedValue(new Error('connection refused')),
      } as unknown as Collection<RateLimitDocument>;
      const store = new MongoStore({
        mongo: { collection: brokenCollection },
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 42_000,
        maxRequests: 10,
        ensureIndexes: false,
        onMongoError: 'fail-open',
      });
      const r = await store.increment('k');
      expect(r.storeUnavailable).toBe(true);
      expect(r.resetTime.getTime()).toBe(t0 + 42_000);
      await store.shutdown();
    });
  });

  it('mongoPreset is exported from ratelimit-flex', async () => {
    const { mongoPreset } = await import('ratelimit-flex');
    expect(typeof mongoPreset).toBe('function');
  });

  describe('mongoPreset options merging', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('forwards overrides.maxRequests to the MongoStore (not hardcoded 100)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
      const db = client.db(TEST_DB);
      const opts = await import('ratelimit-flex').then((m) =>
        m.mongoPreset({ client, dbName: TEST_DB, collectionName: 'preset_override' }, { maxRequests: 3 }),
      );
      expect(opts.maxRequests).toBe(3);
      const store = opts.store!;
      await store.increment('a');
      await store.increment('a');
      await store.increment('a');
      const blocked = await store.increment('a');
      expect(blocked.isBlocked).toBe(true);
      expect(blocked.totalHits).toBe(4);
      await store.shutdown();
      await db.collection('preset_override').deleteMany({});
    });

    it('forwards token bucket overrides (tokensPerInterval, interval, bucketSize)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
      const db = client.db(TEST_DB);
      const opts = await import('ratelimit-flex').then((m) =>
        m.mongoPreset(
          { client, dbName: TEST_DB, collectionName: 'preset_tb' },
          {
            strategy: RateLimitStrategy.TOKEN_BUCKET,
            tokensPerInterval: 5,
            interval: 2000,
            bucketSize: 5,
          },
        ),
      );
      expect(opts.strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
      const store = opts.store!;
      for (let i = 0; i < 5; i++) {
        await store.increment('tb');
      }
      const blocked = await store.increment('tb');
      expect(blocked.isBlocked).toBe(true);
      vi.advanceTimersByTime(2000);
      const ok = await store.increment('tb');
      expect(ok.isBlocked).toBe(false);
      expect(ok.remaining).toBe(4);
      await store.shutdown();
      await db.collection('preset_tb').deleteMany({});
    });
  });
});
