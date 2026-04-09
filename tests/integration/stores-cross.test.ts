/**
 * Cross-cutting integration: {@link PgStore}, {@link MongoStore}, and {@link DynamoStore} with
 * shield, composition, KeyManager, metrics, and framework middleware.
 */
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import Fastify from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from '../../src/composition/index.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { fastifyRateLimiter } from '../../src/middleware/fastify.js';
import { rateLimiter } from '../../src/hono/rateLimiter.js';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { RateLimitModule } from '../../src/nestjs/RateLimitModule.js';
import { RATE_LIMIT_STORE } from '../../src/nestjs/types.js';
import { shield } from '../../src/shield/shield.js';
import { DynamoStore, dynamoStoreTableSchema } from '../../src/stores/dynamo/index.js';
import { MongoStore } from '../../src/stores/mongo/index.js';
import { PgStore } from '../../src/stores/postgres/PgStore.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { CreateTableCommand, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import type { RateLimitResult, RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import {
  clearDynamoRateLimitsTable,
  initDynamoStoreTestBackend,
  runDynamoStoreIntegration,
} from '../stores/dynamo-test-backend.js';
import { initPgStoreTestBackend, runPgStoreIntegration } from '../stores/pg-test-backend.js';

const windowOpts = {
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
} as const;

/** Primary layer that always throws — simulates Postgres outage for {@link compose.firstAvailable}. */
class FailingPrimaryStore implements RateLimitStore {
  async increment(): Promise<RateLimitResult> {
    throw new Error('simulated primary store failure');
  }

  async decrement(): Promise<void> {}

  async reset(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

describe('stores-cross integration', { timeout: 60_000 }, () => {
  // Shared Postgres backend for all PgStore tests
  let pgBackend: Awaited<ReturnType<typeof initPgStoreTestBackend>> | null = null;
  
  // Shared DynamoDB backend for all DynamoStore tests
  let dynamoBackend: Awaited<ReturnType<typeof initDynamoStoreTestBackend>> | null = null;
  let dynamoClient: DynamoDBDocumentClient | null = null;

  beforeAll(async () => {
    if (runPgStoreIntegration) {
      pgBackend = await initPgStoreTestBackend();
    }
    if (runDynamoStoreIntegration) {
      dynamoBackend = await initDynamoStoreTestBackend();
      const raw = new DynamoDBClient({
        endpoint: dynamoBackend.endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      dynamoClient = DynamoDBDocumentClient.from(raw);
      try {
        await raw.send(new CreateTableCommand(dynamoStoreTableSchema));
      } catch (e) {
        if (!(e instanceof ResourceInUseException)) {
          throw e;
        }
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (pgBackend) {
      await pgBackend.cleanup();
    }
    if (dynamoBackend) {
      await dynamoBackend.cleanup();
    }
  });

  describe('InMemoryShield wraps remote stores', () => {
    it.skipIf(!runPgStoreIntegration)(
      'PgStore: blocked keys are cached; later increments skip the inner store',
      async () => {
        const inner = new PgStore({
          client: pgBackend!.pool,
          ...windowOpts,
          autoSweepIntervalMs: 0,
        });
        const shielded = shield(inner, { blockOnConsumed: 3, blockDurationMs: 60_000 });
        shielded.resetMetrics();

        await shielded.increment('shield-pg');
        await shielded.increment('shield-pg');
        const third = await shielded.increment('shield-pg');
        expect(third.totalHits).toBeGreaterThanOrEqual(3);

        const m1 = shielded.getMetrics();
        const fourth = await shielded.increment('shield-pg');
        expect(fourth.shielded).toBe(true);
        const m2 = shielded.getMetrics();
        expect(m2.storeCallsSaved).toBeGreaterThan(m1.storeCallsSaved);

        await shielded.shutdown();
      },
    );

    it('MongoStore (mongodb-memory-server): shield caches after threshold', async () => {
      const mongod = await MongoMemoryServer.create();
      try {
        const client = new MongoClient(mongod.getUri());
        await client.connect();
        const inner = new MongoStore({
          mongo: { client, dbName: 'rlf_cross', collectionName: 'shield_mongo' },
          ...windowOpts,
          ensureIndexes: false,
        });
        const shielded = shield(inner, { blockOnConsumed: 2, blockDurationMs: 60_000 });
        shielded.resetMetrics();
        await shielded.increment('k');
        await shielded.increment('k');
        await shielded.increment('k');
        expect(shielded.getMetrics().storeCallsSaved).toBeGreaterThan(0);
        await shielded.shutdown();
        await client.close();
      } finally {
        await mongod.stop();
      }
    });

    it.skipIf(!runDynamoStoreIntegration)(
      'DynamoStore: shield metrics show saved calls after cache',
      async () => {
        const inner = new DynamoStore({
          client: dynamoClient!,
          tableName: 'rate_limits',
          ...windowOpts,
        });
        const shielded = shield(inner, { blockOnConsumed: 2, blockDurationMs: 60_000 });
        await clearDynamoRateLimitsTable(dynamoClient!, 'rate_limits');
        shielded.resetMetrics();
        await shielded.increment('d');
        await shielded.increment('d');
        await shielded.increment('d');
        expect(shielded.getMetrics().storeCallsSaved).toBeGreaterThan(0);
        await shielded.shutdown();
      },
    );
  });

  describe.skipIf(!runPgStoreIntegration)('compose.all stacks PgStore + MemoryStore', () => {
    it('both layers are consulted on each increment', async () => {
      const pg = new PgStore({
        client: pgBackend!.pool,
        ...windowOpts,
        autoSweepIntervalMs: 0,
      });
      const mem = new MemoryStore({ ...windowOpts });
      const store = compose.all(compose.layer('pg', pg), compose.layer('memory', mem));
      const r = await store.increment('composed-key');
      expect(r.layers).toBeDefined();
      expect(r.layers?.pg?.consulted).toBe(true);
      expect(r.layers?.memory?.consulted).toBe(true);
      await store.shutdown();
    });
  });

  describe('compose.firstAvailable failover', () => {
    it('uses fallback MemoryStore when primary throws', async () => {
      const fallback = new MemoryStore({ ...windowOpts });
      const store = compose.firstAvailable(
        compose.layer('pg', new FailingPrimaryStore()),
        compose.layer('fallback', fallback),
      );
      const r = await store.increment('fa-key');
      expect(r.isBlocked).toBe(false);
      expect(r.decidingLayer).toBe('fallback');
      expect(r.layers?.fallback?.consulted).toBe(true);
      await store.shutdown();
    });
  });

  describe('KeyManager with MongoStore', () => {
    let mongod: MongoMemoryServer;
    let client: MongoClient;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      client = new MongoClient(mongod.getUri());
      await client.connect();
    });

    afterAll(async () => {
      await client?.close();
      await mongod?.stop();
    });

    it('block, unblock, penalty, reward mutate state via the store', async () => {
      const store = new MongoStore({
        mongo: { client, dbName: 'rlf_km', collectionName: 'km' },
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        ensureIndexes: false,
      });
      const km = new KeyManager({
        store,
        maxRequests: 10,
        windowMs: 60_000,
        penaltyBlockThreshold: 100,
      });

      await km.block('u1', 60_000, { type: 'manual' });
      let st = await km.get('u1');
      expect(st?.isManuallyBlocked).toBe(true);

      await km.unblock('u1');
      st = await km.get('u1');
      expect(st).toBeNull();

      await store.increment('u2');
      await km.penalty('u2', 2);
      st = await km.get('u2');
      expect(st?.penaltyPoints).toBeGreaterThanOrEqual(2);

      await km.reward('u2', 1);
      st = await km.get('u2');
      expect(st?.rewardPoints).toBeGreaterThanOrEqual(1);

      await km.destroy();
      await store.shutdown();
    });
  });

  describe.skipIf(!runDynamoStoreIntegration)('metrics: store latency with DynamoStore', () => {
    it('records store_duration in snapshot after requests', async () => {
      const store = new DynamoStore({
        client: dynamoClient!,
        tableName: 'rate_limits',
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      });
      await clearDynamoRateLimitsTable(dynamoClient!, 'rate_limits');

      const limiter = expressRateLimiter({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
        keyGenerator: () => 'metrics-ip',
        store,
        metrics: true,
      });

      const app = express();
      app.use(limiter);
      app.get('/ok', (_req, res) => {
        res.status(200).json({ ok: true });
      });

      for (let i = 0; i < 5; i++) {
        await request(app).get('/ok').expect(200);
      }

      await new Promise<void>((r) => setTimeout(r, 10_500));
      const snap = limiter.getMetricsSnapshot();
      expect(snap).not.toBeNull();
      expect(snap!.storeLatencySamplesMs?.length ?? 0).toBeGreaterThan(0);
      expect(snap!.storeLatency.p50).toBeGreaterThanOrEqual(0);

      await limiter.shutdownMetrics();
      await store.shutdown();
    });
  });

  describe('framework smoke: middleware + each store type', () => {
    const smokeOpts = {
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 10_000,
      maxRequests: 50,
      keyGenerator: () => 'smoke-key',
    } as const;

    @Controller()
    class FrameworkSmokeController {
      @Get('x')
      x() {
        return { ok: true };
      }
    }

    async function nestHttpSmoke(store: RateLimitStore): Promise<void> {
      @Module({
        imports: [
          RateLimitModule.forRoot({
            store,
            maxRequests: smokeOpts.maxRequests,
            windowMs: smokeOpts.windowMs,
            strategy: smokeOpts.strategy,
            globalGuard: false,
          }),
        ],
        controllers: [FrameworkSmokeController],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      expect(moduleRef.get(RATE_LIMIT_STORE)).toBe(store);
      const app = moduleRef.createNestApplication();
      await app.init();
      await request(app.getHttpServer()).get('/x').expect(200);
      await app.close();
      await store.shutdown();
    }

    async function runFastifySmoke(store: RateLimitStore): Promise<void> {
      const app = Fastify();
      await app.register(fastifyRateLimiter, { ...smokeOpts, store });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({ method: 'GET', url: '/x' });
      expect(res.statusCode).toBe(200);
      await app.close();
      await store.shutdown();
    }

    async function runHonoSmoke(store: RateLimitStore): Promise<void> {
      const app = new Hono();
      app.use('*', rateLimiter({ ...smokeOpts, store, keyGenerator: () => 'smoke-key' }));
      app.get('/x', (c) => c.json({ ok: true }));
      const res = await app.request('http://localhost/x');
      expect(res.status).toBe(200);
      await store.shutdown();
    }

    async function ensureDynamoTable(raw: DynamoDBClient): Promise<void> {
      try {
        await raw.send(new CreateTableCommand(dynamoStoreTableSchema));
      } catch (e) {
        if (!(e instanceof ResourceInUseException)) {
          throw e;
        }
      }
    }

    it('Express + MemoryStore', async () => {
      const store = new MemoryStore({ ...smokeOpts });
      const app = express();
      app.use(expressRateLimiter({ ...smokeOpts, store }));
      app.get('/x', (_q, res) => res.send('ok'));
      await request(app).get('/x').expect(200);
      await store.shutdown();
    });

    it('Fastify + MemoryStore', async () => {
      await runFastifySmoke(new MemoryStore({ ...smokeOpts }));
    });

    it('Hono + MemoryStore', async () => {
      await runHonoSmoke(new MemoryStore({ ...smokeOpts }));
    });

    it('NestJS + MemoryStore (HTTP)', async () => {
      await nestHttpSmoke(new MemoryStore({ ...smokeOpts }));
    });

    it.skipIf(!runPgStoreIntegration)('Express + PgStore', async () => {
      const store = new PgStore({
        client: pgBackend!.pool,
        ...smokeOpts,
        autoSweepIntervalMs: 0,
      });
      const app = express();
      app.use(expressRateLimiter({ ...smokeOpts, store }));
      app.get('/x', (_q, res) => res.json({ ok: true }));
      await request(app).get('/x').expect(200);
      await store.shutdown();
    });

    it.skipIf(!runPgStoreIntegration)('Fastify + PgStore', async () => {
      await runFastifySmoke(
        new PgStore({ client: pgBackend!.pool, ...smokeOpts, autoSweepIntervalMs: 0 }),
      );
    });

    it.skipIf(!runPgStoreIntegration)('Hono + PgStore', async () => {
      await runHonoSmoke(
        new PgStore({ client: pgBackend!.pool, ...smokeOpts, autoSweepIntervalMs: 0 }),
      );
    });

    it.skipIf(!runPgStoreIntegration)('NestJS + PgStore (HTTP)', async () => {
      await nestHttpSmoke(
        new PgStore({ client: pgBackend!.pool, ...smokeOpts, autoSweepIntervalMs: 0 }),
      );
    });

    it('Express + MongoStore', async () => {
      const mongod = await MongoMemoryServer.create();
      try {
        const client = new MongoClient(mongod.getUri());
        await client.connect();
        const store = new MongoStore({
          mongo: { client, dbName: 'rlf_smoke', collectionName: 'express' },
          ...smokeOpts,
          ensureIndexes: false,
        });
        const app = express();
        app.use(expressRateLimiter({ ...smokeOpts, store }));
        app.get('/x', (_q, res) => res.json({ ok: true }));
        await request(app).get('/x').expect(200);
        await store.shutdown();
        await client.close();
      } finally {
        await mongod.stop();
      }
    });

    it('Fastify + MongoStore', async () => {
      const mongod = await MongoMemoryServer.create();
      try {
        const client = new MongoClient(mongod.getUri());
        await client.connect();
        await runFastifySmoke(
          new MongoStore({
            mongo: { client, dbName: 'rlf_smoke', collectionName: 'fastify' },
            ...smokeOpts,
            ensureIndexes: false,
          }),
        );
        await client.close();
      } finally {
        await mongod.stop();
      }
    });

    it('Hono + MongoStore', async () => {
      const mongod = await MongoMemoryServer.create();
      try {
        const client = new MongoClient(mongod.getUri());
        await client.connect();
        await runHonoSmoke(
          new MongoStore({
            mongo: { client, dbName: 'rlf_smoke', collectionName: 'hono' },
            ...smokeOpts,
            ensureIndexes: false,
          }),
        );
        await client.close();
      } finally {
        await mongod.stop();
      }
    });

    it('NestJS + MongoStore (HTTP)', async () => {
      const mongod = await MongoMemoryServer.create();
      try {
        const client = new MongoClient(mongod.getUri());
        await client.connect();
        await nestHttpSmoke(
          new MongoStore({
            mongo: { client, dbName: 'rlf_smoke', collectionName: 'nest' },
            ...smokeOpts,
            ensureIndexes: false,
          }),
        );
        await client.close();
      } finally {
        await mongod.stop();
      }
    });

    it.skipIf(!runDynamoStoreIntegration)('Express + DynamoStore', async () => {
      const store = new DynamoStore({
        client: dynamoClient!,
        tableName: 'rate_limits',
        ...smokeOpts,
      });
      await clearDynamoRateLimitsTable(dynamoClient!, 'rate_limits');
      const app = express();
      app.use(expressRateLimiter({ ...smokeOpts, store }));
      app.get('/x', (_q, res) => res.json({ ok: true }));
      await request(app).get('/x').expect(200);
      await store.shutdown();
    });

    it.skipIf(!runDynamoStoreIntegration)('Fastify + DynamoStore', async () => {
      await clearDynamoRateLimitsTable(dynamoClient!, 'rate_limits');
      await runFastifySmoke(
        new DynamoStore({ client: dynamoClient!, tableName: 'rate_limits', ...smokeOpts }),
      );
    });

    it.skipIf(!runDynamoStoreIntegration)('Hono + DynamoStore', async () => {
      await clearDynamoRateLimitsTable(dynamoClient!, 'rate_limits');
      await runHonoSmoke(
        new DynamoStore({ client: dynamoClient!, tableName: 'rate_limits', ...smokeOpts }),
      );
    });

    it.skipIf(!runDynamoStoreIntegration)('NestJS + DynamoStore (HTTP)', async () => {
      await clearDynamoRateLimitsTable(dynamoClient!, 'rate_limits');
      await nestHttpSmoke(
        new DynamoStore({ client: dynamoClient!, tableName: 'rate_limits', ...smokeOpts }),
      );
    });
  });
});
