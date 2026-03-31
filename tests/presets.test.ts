import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expressRateLimiter } from '../src/middleware/express.js';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';
import {
  apiGatewayPreset,
  apiKeyHeaderKeyGenerator,
  authEndpointPreset,
  multiInstancePreset,
  publicApiPreset,
  singleInstancePreset,
} from '../src/presets/index.js';
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

const memoryStores: MemoryStore[] = [];
const redisStores: RedisStore[] = [];

function trackMemoryStore(s: MemoryStore): MemoryStore {
  memoryStores.push(s);
  return s;
}

function trackRedisStore(s: RedisStore): RedisStore {
  redisStores.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all([
    ...memoryStores.splice(0).map((s) => s.shutdown()),
    ...redisStores.splice(0).map((s) => s.shutdown()),
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
    });

    it('defaults: sliding window, 100 req / 60s window', () => {
      const p = singleInstancePreset();
      expect(p.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(p.windowMs).toBe(60_000);
      expect(p.maxRequests).toBe(100);
    });

    it('user override: maxRequests 50', () => {
      const merged = mergeRateLimiterOptions(singleInstancePreset({ maxRequests: 50 }));
      expect(merged.maxRequests).toBe(50);
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
    });

    it('defaults: sliding window, 100 req / 60s', () => {
      const m = multiInstancePreset({ client: mockRedisClient() });
      expect(m.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(m.windowMs).toBe(60_000);
      expect(m.maxRequests).toBe(100);
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
    });

    it('defaults: token bucket 30/min, burst 60', () => {
      const p = apiGatewayPreset({ client: mockRedisClient() });
      expect(p.strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
      expect(p.tokensPerInterval).toBe(30);
      expect(p.interval).toBe(60_000);
      expect(p.bucketSize).toBe(60);
    });

    it('user override: tokensPerInterval 50', () => {
      const merged = mergeRateLimiterOptions(
        apiGatewayPreset({ client: mockRedisClient() }, { tokensPerInterval: 50 }),
      );
      expect(merged.tokensPerInterval).toBe(50);
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
    });

    it('defaults: fixed window, 5 req / min', () => {
      const p = authEndpointPreset({ client: mockRedisClient() });
      expect(p.strategy).toBe(RateLimitStrategy.FIXED_WINDOW);
      expect(p.windowMs).toBe(60_000);
      expect(p.maxRequests).toBe(5);
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
    });

    it('defaults: sliding window, 60 req / min, structured message', () => {
      const p = publicApiPreset();
      expect(p.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
      expect(p.windowMs).toBe(60_000);
      expect(p.maxRequests).toBe(60);
      expect(p.message).toEqual({
        error: 'Rate limit exceeded',
        retryAfter: '<seconds>',
      });
    });

    it('user override: maxRequests 50', () => {
      const merged = mergeRateLimiterOptions(publicApiPreset({ maxRequests: 50 }));
      expect(merged.maxRequests).toBe(50);
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
    expect(evalMock.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
