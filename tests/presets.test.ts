import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expressRateLimiter } from '../src/middleware/express.js';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';
import * as environment from '../src/utils/environment.js';
import { ComposedStore } from '../src/composition/ComposedStore.js';
import {
  apiGatewayPreset,
  apiKeyHeaderKeyGenerator,
  authEndpointPreset,
  multiInstancePreset,
  publicApiPreset,
  resilientRedisPreset,
  singleInstancePreset,
} from '../src/presets/index.js';
import {
  burstablePreset,
  failoverPreset,
  multiWindowPreset,
} from '../src/composition/index.js';
import { defaultKeyGenerator } from '../src/strategies/rate-limit-engine.js';
import type { RedisLikeClient } from '../src/stores/redis-store.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RedisStore } from '../src/stores/redis-store.js';
import { RateLimitStrategy } from '../src/types/index.js';
import type { RateLimitOptions } from '../src/types/index.js';

function mockRedisClient(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Stateful mock matching Redis fixed-window Lua return shape `{ current, blocked, reset_at }`. */
function createFixedWindowEvalMock() {
  const counts = new Map<string, number>();
  return vi.fn((script: string, numKeys: number, ...keysAndArgs: string[]) => {
    const keys = keysAndArgs.slice(0, numKeys);
    const argv = keysAndArgs.slice(numKeys);
    const redisKey = keys[0]!;
    const windowMs = Number(argv[0]);
    const maxReq = Number(argv[1]);
    const now = Number(argv[2]);
    const current = (counts.get(redisKey) ?? 0) + 1;
    counts.set(redisKey, current);
    const blocked = current > maxReq ? 1 : 0;
    const reset_at = now + windowMs;
    return [String(current), String(blocked), String(reset_at)];
  });
}

function throwingRedisClient(): RedisLikeClient {
  const reject = (): Promise<never> => Promise.reject(new Error('redis down'));
  return {
    get: reject,
    set: reject,
    eval: reject,
  };
}

function assertResolvedOptions(merged: RateLimitOptions): void {
  expect(merged.store).toBeDefined();
  expect(typeof merged.store.increment).toBe('function');
  expect(typeof merged.store.shutdown).toBe('function');
  expect(merged.strategy).toBeDefined();
}

function memoryMaxRequests(store: MemoryStore): number {
  return (store as unknown as { maxRequests: number }).maxRequests;
}

function insuranceStoreFromRedis(store: RedisStore): MemoryStore {
  return store['insuranceStore' as keyof RedisStore] as MemoryStore;
}

const memoryStores: MemoryStore[] = [];
const redisStores: RedisStore[] = [];
const composedStores: ComposedStore[] = [];

function trackMemoryStore(s: MemoryStore): MemoryStore {
  memoryStores.push(s);
  return s;
}

function trackRedisStore(s: RedisStore): RedisStore {
  redisStores.push(s);
  return s;
}

function trackComposedStore(s: ComposedStore): ComposedStore {
  composedStores.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all([
    ...memoryStores.splice(0).map((s) => s.shutdown()),
    ...redisStores.splice(0).map((s) => s.shutdown()),
    ...composedStores.splice(0).map((s) => s.shutdown()),
  ]);
});

describe('presets — unit', () => {
  describe('singleInstancePreset', () => {
    it('merges to valid RateLimitOptions with MemoryStore', () => {
      const merged = mergeRateLimiterOptions(singleInstancePreset());
      assertResolvedOptions(merged);
      expect(merged.store).toBeInstanceOf(MemoryStore);
      expect(merged.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(merged.windowMs).toBe(60_000);
      expect(merged.maxRequests).toBe(100);
      expect(merged.standardHeaders).toBe('draft-6');
      expect(merged.legacyHeaders).toBe(true);
    });

    it('defaults: sliding window, 100 req / 60s window', () => {
      const p = singleInstancePreset();
      expect(p.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(p.windowMs).toBe(60_000);
      expect(p.maxRequests).toBe(100);
      expect(p.standardHeaders).toBe('draft-6');
      expect(p.legacyHeaders).toBe(true);
    });

    it('user override: maxRequests 50', () => {
      const merged = mergeRateLimiterOptions(singleInstancePreset({ maxRequests: 50 }));
      expect(merged.maxRequests).toBe(50);
    });

    it('user can override standardHeaders', () => {
      const merged = mergeRateLimiterOptions(
        singleInstancePreset({ standardHeaders: 'legacy', legacyHeaders: false }),
      );
      expect(merged.standardHeaders).toBe('legacy');
      expect(merged.legacyHeaders).toBe(false);
    });

    it('does not set inMemoryBlock (MemoryStore — shielding is not used)', () => {
      expect(singleInstancePreset().inMemoryBlock).toBeUndefined();
      const merged = mergeRateLimiterOptions(singleInstancePreset());
      expect(merged.inMemoryBlock).toBeUndefined();
    });
  });

  describe('multiInstancePreset', () => {
    it('merges to valid RateLimitOptions with RedisStore', () => {
      const client = mockRedisClient();
      const merged = mergeRateLimiterOptions(multiInstancePreset({ client }));
      assertResolvedOptions(merged);
      expect(merged.store).toBeInstanceOf(RedisStore);
      expect(merged.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(merged.windowMs).toBe(60_000);
      expect(merged.maxRequests).toBe(100);
      expect(merged.standardHeaders).toBe('draft-6');
      expect(merged.legacyHeaders).toBe(false);
    });

    it('defaults: sliding window, 100 req / 60s', () => {
      const m = multiInstancePreset({ client: mockRedisClient() });
      expect(m.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(m.windowMs).toBe(60_000);
      expect(m.maxRequests).toBe(100);
      expect(m.standardHeaders).toBe('draft-6');
      expect(m.legacyHeaders).toBe(false);
    });

    it('sets inMemoryBlock true by default for Redis-backed limits', () => {
      const m = multiInstancePreset({ client: mockRedisClient() });
      expect(m.inMemoryBlock).toBe(true);
      const merged = mergeRateLimiterOptions(m);
      expect(merged.inMemoryBlock).toBe(true);
    });

    it('user can override inMemoryBlock to false', () => {
      const m = multiInstancePreset({ client: mockRedisClient() }, { inMemoryBlock: false });
      expect(m.inMemoryBlock).toBe(false);
      const merged = mergeRateLimiterOptions(m);
      expect(merged.inMemoryBlock).toBe(false);
    });

    it('user override: maxRequests 50', () => {
      const merged = mergeRateLimiterOptions(
        multiInstancePreset({ client: mockRedisClient() }, { maxRequests: 50 }),
      );
      expect(merged.maxRequests).toBe(50);
    });

    it('RedisStore uses fail-open by default (increment allows when Redis fails)', async () => {
      const merged = mergeRateLimiterOptions(
        multiInstancePreset({ client: throwingRedisClient() }),
      );
      trackRedisStore(merged.store as RedisStore);
      const r = await merged.store.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(r.storeUnavailable).toBeUndefined();
    });

    it('passes windowMs and maxRequests into RedisStore (observable via sliding-window eval argv)', async () => {
      const evalMock = vi.fn().mockResolvedValue([1, 0, String(Date.now() + 60_000)]);
      const client = mockRedisClient({ eval: evalMock });
      const merged = mergeRateLimiterOptions(
        multiInstancePreset({ client }, { windowMs: 30_000, maxRequests: 42 }),
      );
      trackRedisStore(merged.store as RedisStore);
      await merged.store.increment('my-key');
      expect(evalMock).toHaveBeenCalled();
      const call = evalMock.mock.calls[0];
      expect(call).toBeDefined();
      const keysAndArgs = call!.slice(2) as string[];
      const numKeys = Number(call![1]);
      const argv = keysAndArgs.slice(numKeys);
      expect(argv[1]).toBe('30000');
      expect(argv[2]).toBe('42');
    });
  });

  describe('apiGatewayPreset', () => {
    it('merges to valid RateLimitOptions with RedisStore (token bucket)', () => {
      const merged = mergeRateLimiterOptions(apiGatewayPreset({ client: mockRedisClient() }));
      assertResolvedOptions(merged);
      expect(merged.store).toBeInstanceOf(RedisStore);
      expect(merged.strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
      expect(merged.tokensPerInterval).toBe(30);
      expect(merged.interval).toBe(60_000);
      expect(merged.bucketSize).toBe(60);
      expect(merged.standardHeaders).toBe('draft-8');
      expect(merged.legacyHeaders).toBe(false);
      expect(merged.identifier).toBe('api-gateway');
    });

    it('defaults: token bucket 30/min, burst 60', () => {
      const p = apiGatewayPreset({ client: mockRedisClient() });
      expect(p.strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
      expect(p.tokensPerInterval).toBe(30);
      expect(p.interval).toBe(60_000);
      expect(p.bucketSize).toBe(60);
      expect(p.standardHeaders).toBe('draft-8');
      expect(p.legacyHeaders).toBe(false);
      expect(p.identifier).toBe('api-gateway');
    });

    it('sets inMemoryBlock true by default', () => {
      expect(apiGatewayPreset({ client: mockRedisClient() }).inMemoryBlock).toBe(true);
    });

    it('user override: tokensPerInterval 50', () => {
      const merged = mergeRateLimiterOptions(
        apiGatewayPreset({ client: mockRedisClient() }, { tokensPerInterval: 50 }),
      );
      expect(merged.tokensPerInterval).toBe(50);
    });

    it('user can override identifier and standardHeaders', () => {
      const merged = mergeRateLimiterOptions(
        apiGatewayPreset(
          { client: mockRedisClient() },
          { identifier: 'my-gateway', standardHeaders: 'draft-6' },
        ),
      );
      expect(merged.identifier).toBe('my-gateway');
      expect(merged.standardHeaders).toBe('draft-6');
    });

    it('RedisStore uses fail-closed by default (increment blocks when Redis fails)', async () => {
      const merged = mergeRateLimiterOptions(
        apiGatewayPreset({ client: throwingRedisClient() }),
      );
      trackRedisStore(merged.store as RedisStore);
      const r = await merged.store.increment('k');
      expect(r.isBlocked).toBe(true);
      expect(r.storeUnavailable).toBe(true);
    });

    it('keyGenerator reads x-api-key header', () => {
      const kg = apiGatewayPreset({ client: mockRedisClient() }).keyGenerator!;
      expect(kg({ headers: { 'x-api-key': 'gateway-secret' } })).toBe('gateway-secret');
      expect(apiKeyHeaderKeyGenerator({ headers: { 'x-api-key': 'a' } })).toBe('a');
    });
  });

  describe('authEndpointPreset', () => {
    it('merges to valid RateLimitOptions with RedisStore (fixed window)', () => {
      const merged = mergeRateLimiterOptions(authEndpointPreset({ client: mockRedisClient() }));
      assertResolvedOptions(merged);
      expect(merged.store).toBeInstanceOf(RedisStore);
      expect(merged.strategy).toBe(RateLimitStrategy.FIXED_WINDOW);
      expect(merged.windowMs).toBe(60_000);
      expect(merged.maxRequests).toBe(5);
      expect(merged.standardHeaders).toBe('draft-6');
      expect(merged.legacyHeaders).toBe(false);
    });

    it('defaults: fixed window, 5 req / min', () => {
      const p = authEndpointPreset({ client: mockRedisClient() });
      expect(p.strategy).toBe(RateLimitStrategy.FIXED_WINDOW);
      expect(p.windowMs).toBe(60_000);
      expect(p.maxRequests).toBe(5);
      expect(p.standardHeaders).toBe('draft-6');
      expect(p.legacyHeaders).toBe(false);
    });

    it('sets inMemoryBlock true by default', () => {
      expect(authEndpointPreset({ client: mockRedisClient() }).inMemoryBlock).toBe(true);
    });

    it('user override: maxRequests 50', () => {
      const merged = mergeRateLimiterOptions(
        authEndpointPreset({ client: mockRedisClient() }, { maxRequests: 50 }),
      );
      expect(merged.maxRequests).toBe(50);
    });

    it('RedisStore uses fail-closed by default', async () => {
      const merged = mergeRateLimiterOptions(
        authEndpointPreset({ client: throwingRedisClient() }),
      );
      trackRedisStore(merged.store as RedisStore);
      const r = await merged.store.increment('k');
      expect(r.isBlocked).toBe(true);
      expect(r.storeUnavailable).toBe(true);
    });

    it('keyGenerator matches defaultKeyGenerator (uses req.ip)', () => {
      const kg = authEndpointPreset({ client: mockRedisClient() }).keyGenerator!;
      expect(kg).toBe(defaultKeyGenerator);
      expect(kg({ ip: '198.51.100.7' })).toBe('198.51.100.7');
    });
  });

  describe('publicApiPreset', () => {
    it('merges to valid RateLimitOptions with MemoryStore', () => {
      const merged = mergeRateLimiterOptions(publicApiPreset());
      assertResolvedOptions(merged);
      expect(merged.store).toBeInstanceOf(MemoryStore);
      expect(merged.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(merged.windowMs).toBe(60_000);
      expect(merged.maxRequests).toBe(60);
      expect(merged.standardHeaders).toBe('draft-7');
      expect(merged.legacyHeaders).toBe(false);
    });

    it('defaults: sliding window, 60 req / min, structured message', () => {
      const p = publicApiPreset();
      expect(p.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(p.windowMs).toBe(60_000);
      expect(p.maxRequests).toBe(60);
      expect(p.standardHeaders).toBe('draft-7');
      expect(p.legacyHeaders).toBe(false);
      expect(p.message).toEqual({
        error: 'Rate limit exceeded',
        retryAfter: '<seconds>',
      });
    });

    it('does not set inMemoryBlock (MemoryStore by default)', () => {
      expect(publicApiPreset().inMemoryBlock).toBeUndefined();
    });

    it('user override: maxRequests 50', () => {
      const merged = mergeRateLimiterOptions(publicApiPreset({ maxRequests: 50 }));
      expect(merged.maxRequests).toBe(50);
    });
  });

  describe('composition presets (multiWindow, burstable, failover)', () => {
    it('multiWindowPreset throws when windows is empty', () => {
      expect(() =>
        multiWindowPreset({ client: mockRedisClient() }, []),
      ).toThrow(/non-empty/);
    });

    it('multiWindowPreset: ComposedStore all mode, min window/cap, distinct Redis key prefixes', async () => {
      const evalMock = vi.fn().mockResolvedValue([1, 0, String(Date.now() + 60_000)]);
      const client = mockRedisClient({ eval: evalMock });
      const partial = multiWindowPreset(
        { client, prefix: 'rlf:' },
        [
          { windowMs: 1_000, maxRequests: 10 },
          { windowMs: 60_000, maxRequests: 100 },
        ],
      );
      const merged = mergeRateLimiterOptions(partial);
      const store = trackComposedStore(merged.store as ComposedStore);
      expect(store.mode).toBe('all');
      expect(store.layers).toHaveLength(2);
      expect(store.layers[0]!.label).toBe('limit-0');
      expect(store.layers[1]!.label).toBe('limit-1');
      expect(merged.windowMs).toBe(1_000);
      expect(merged.maxRequests).toBe(10);
      expect(merged.standardHeaders).toBe('draft-6');
      expect(merged.legacyHeaders).toBe(false);

      await store.increment('k');
      expect(evalMock.mock.calls.length).toBe(2);
      const k0 = String(evalMock.mock.calls[0]![2]);
      const k1 = String(evalMock.mock.calls[1]![2]);
      expect(k0).toContain('mw:0:w1000');
      expect(k1).toContain('mw:1:w60000');
    });

    it('burstablePreset: overflow ComposedStore with steady + burst RedisStores', () => {
      const client = mockRedisClient();
      const partial = burstablePreset(
        { client, prefix: 'rlf:' },
        {
          steady: { windowMs: 1_000, maxRequests: 5 },
          burst: { windowMs: 60_000, maxRequests: 20 },
        },
      );
      const merged = mergeRateLimiterOptions(partial);
      const store = merged.store as ComposedStore;
      trackComposedStore(store);
      expect(store.mode).toBe('overflow');
      expect(store.layers.map((l) => l.label)).toEqual(['steady', 'burst']);
      expect(merged.windowMs).toBe(1_000);
      expect(merged.maxRequests).toBe(5);
      expect(merged.standardHeaders).toBe('draft-6');
    });

    it('failoverPreset: first-available ComposedStore', async () => {
      const a = trackMemoryStore(new MemoryStore({ strategy: RateLimitStrategy.SLIDING_WINDOW, windowMs: 60_000, maxRequests: 10 }));
      const b = trackMemoryStore(new MemoryStore({ strategy: RateLimitStrategy.SLIDING_WINDOW, windowMs: 60_000, maxRequests: 10 }));
      const partial = failoverPreset(
        [
          { label: 'primary', store: a },
          { label: 'fallback', store: b },
        ],
        { maxRequests: 10 },
      );
      const merged = mergeRateLimiterOptions(partial);
      const store = trackComposedStore(merged.store as ComposedStore);
      expect(store.mode).toBe('first-available');
      const r = await store.increment('k');
      expect(r.decidingLayer).toBe('primary');
      expect(r.layers.fallback?.consulted).toBe(false);
      expect(a.getActiveKeys().has('k')).toBe(true);
      expect(b.getActiveKeys().has('k')).toBe(false);
    });
  });

  describe('resilientRedisPreset', () => {
    it('sets inMemoryBlock true by default', () => {
      expect(resilientRedisPreset({ client: mockRedisClient() }).inMemoryBlock).toBe(true);
    });

    it('merges to valid RateLimitOptions with RedisStore and insurance MemoryStore (defaults)', () => {
      const client = mockRedisClient();
      const partial = resilientRedisPreset({ client });
      expect(partial.standardHeaders).toBe('draft-6');
      expect(partial.legacyHeaders).toBe(false);
      const merged = mergeRateLimiterOptions(partial);
      assertResolvedOptions(merged);
      expect(merged.store).toBeInstanceOf(RedisStore);
      expect(merged.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(merged.windowMs).toBe(60_000);
      expect(merged.maxRequests).toBe(100);
      expect(merged.standardHeaders).toBe('draft-6');
      expect(merged.legacyHeaders).toBe(false);
      const ins = insuranceStoreFromRedis(merged.store as RedisStore);
      expect(memoryMaxRequests(ins)).toBe(100);
    });

    it('sets insurance maxRequests to ceil(maxRequests / estimatedWorkers)', () => {
      const client = mockRedisClient();
      const merged = mergeRateLimiterOptions(
        resilientRedisPreset({ client }, { maxRequests: 300, estimatedWorkers: 5 }),
      );
      const ins = insuranceStoreFromRedis(merged.store as RedisStore);
      expect(memoryMaxRequests(ins)).toBe(60);
    });

    it('uses detectEnvironment when estimatedWorkers is omitted (Kubernetes → 4 workers)', () => {
      const spy = vi.spyOn(environment, 'detectEnvironment').mockReturnValue({
        isCluster: false,
        isNativeCluster: false,
        isKubernetes: true,
        isDocker: false,
        isMultiInstance: true,
        recommended: 'redis',
      });
      const client = mockRedisClient();
      const merged = mergeRateLimiterOptions(
        resilientRedisPreset({ client }, { maxRequests: 300 }),
      );
      const ins = insuranceStoreFromRedis(merged.store as RedisStore);
      expect(memoryMaxRequests(ins)).toBe(75);
      spy.mockRestore();
    });

    it('passes hooks, circuitBreaker, and syncOnRecovery into RedisStore resilience', () => {
      const onFailover = vi.fn();
      const circuitBreaker = { failureThreshold: 9, recoveryTimeMs: 12_000 };
      const client = mockRedisClient();
      const partial = resilientRedisPreset(
        { client },
        {
          hooks: { onFailover },
          circuitBreaker,
          syncOnRecovery: false,
        },
      );
      const store = partial.store as RedisStore;
      trackRedisStore(store);
      const resilience = store['resilience' as keyof RedisStore] as import('../src/resilience/types.js').RedisResilienceOptions;
      expect(resilience?.hooks?.onFailover).toBe(onFailover);
      expect(resilience?.circuitBreaker?.failureThreshold).toBe(9);
      expect(resilience?.circuitBreaker?.recoveryTimeMs).toBe(12_000);
      expect(resilience?.insuranceLimiter?.syncOnRecovery).toBe(false);
    });
  });
});

describe('presets — integration (Express + supertest)', () => {
  it('singleInstancePreset: rate limits after maxRequests', async () => {
    const app = express();
    const store = trackMemoryStore(
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 2000,
        maxRequests: 2,
      }),
    );
    app.use(
      expressRateLimiter(
        singleInstancePreset({
          windowMs: 2000,
          maxRequests: 2,
          store,
        }),
      ),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const a = await request(app).get('/ok');
    const b = await request(app).get('/ok');
    const c = await request(app).get('/ok');

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
  });

  it('authEndpointPreset: 6th request is blocked (fixed window, max 5)', async () => {
    const evalMock = createFixedWindowEvalMock();
    const client: RedisLikeClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      eval: evalMock,
    };
    const preset = authEndpointPreset({ client });
    const store = preset.store as RedisStore;
    trackRedisStore(store);

    const app = express();
    app.set('trust proxy', true);
    app.use(expressRateLimiter(preset));
    app.post('/login', (req, res) => {
      res.status(200).json({ ok: true });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/login')
        .set('X-Forwarded-For', '203.0.113.50');
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
    // Default inMemoryBlock: 5th consume hits the limit and caches; 6th is shielded (no Redis eval).
    expect(evalMock.mock.calls.length).toBe(5);
  });

  it('resilientRedisPreset: enforces maxRequests when passed to expressRateLimiter', async () => {
    let count = 0;
    const evalMock = vi.fn().mockImplementation(async () => {
      count++;
      const blocked = count > 2 ? 1 : 0;
      return [count, blocked, String(Date.now() + 2000)];
    });
    const client = mockRedisClient({ eval: evalMock });
    const merged = mergeRateLimiterOptions(
      resilientRedisPreset({ client }, { windowMs: 2000, maxRequests: 2 }),
    );
    trackRedisStore(merged.store as RedisStore);

    const app = express();
    app.use(expressRateLimiter(merged));
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const a = await request(app).get('/ok');
    const b = await request(app).get('/ok');
    const c = await request(app).get('/ok');

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
  });
});
