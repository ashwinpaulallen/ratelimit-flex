/**
 * Integration tests for {@link MongoStore} against a real MongoDB instance
 * via mongodb-memory-server.
 */
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoStore } from '../../src/stores/mongo/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe(
  'MongoStore integration (fixed window + token bucket)',
  { timeout: 300_000 },
  () => {
    let mongod!: MongoMemoryServer;
    let client!: MongoClient;
    let uri!: string;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      uri = mongod.getUri();
      client = new MongoClient(uri);
      await client.connect();
    });

    afterAll(async () => {
      await client?.close();
      await mongod?.stop();
    });

    it('creates a TTL index on resetAt (expireAfterSeconds: 0)', async () => {
      const db = client.db('rlf_mongo_test');
      const coll = db.collection('ttl_idx');
      const store = new MongoStore({
        mongo: { db, collectionName: 'ttl_idx' },
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        ensureIndexes: true,
      });
      await store.increment('idx-key');
      const indexes = await coll.listIndexes().toArray();
      const ttl = indexes.find(
        (ix) =>
          ix.key &&
          typeof ix.key === 'object' &&
          'resetAt' in (ix.key as Record<string, number>),
      );
      expect(ttl).toBeDefined();
      expect(ttl?.expireAfterSeconds).toBe(0);
      await store.shutdown();
    });

    it('upsert: true creates the document on first increment', async () => {
      const db = client.db('rlf_mongo_test');
      const coll = db.collection('upsert_one');
      await coll.deleteMany({});
      expect(await coll.countDocuments()).toBe(0);

      const store = new MongoStore({
        mongo: { db, collectionName: 'upsert_one' },
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 10_000,
        maxRequests: 100,
      });
      await store.increment('new-key');
      expect(await coll.countDocuments()).toBe(1);
      const doc = await coll.findOne({ _id: 'rlf:new-key' });
      expect(doc?.totalHits).toBe(1);
      expect(doc?.resetAt).toBeInstanceOf(Date);
      await store.shutdown();
    });

    it('concurrent increments produce correct totalHits (fixed window)', async () => {
      const db = client.db('rlf_mongo_test');
      const store = new MongoStore({
        mongo: { db, collectionName: 'conc_fw' },
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 25,
      });
      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.increment('conc-fw')),
      );
      expect(results.filter((r) => r.isBlocked).length).toBe(25);
      expect(Math.max(...results.map((r) => r.totalHits))).toBe(50);
      await store.shutdown();
    });

    it('rolls the fixed window when resetAt passes (pipeline $cond)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const db = client.db('rlf_mongo_test');
      const store = new MongoStore({
        mongo: { db, collectionName: 'fw_roll' },
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 1000,
        maxRequests: 2,
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

    it('token bucket refill math matches whole intervals (MemoryStore semantics)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      const db = client.db('rlf_mongo_test');
      const store = new MongoStore({
        mongo: { db, collectionName: 'tb_refill' },
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        bucketSize: 3,
        tokensPerInterval: 3,
        interval: 1000,
      });
      await store.increment('tb');
      await store.increment('tb');
      await store.increment('tb');
      const blocked = await store.increment('tb');
      expect(blocked.isBlocked).toBe(true);
      const raw = await db.collection('tb_refill').findOne({ _id: 'rlf:tb' });
      expect(raw?.rlfTbBlocked).toBeUndefined();
      vi.advanceTimersByTime(1000);
      const ok = await store.increment('tb');
      expect(ok.isBlocked).toBe(false);
      expect(ok.remaining).toBe(2);
      await store.shutdown();
      vi.useRealTimers();
    });
  },
);
