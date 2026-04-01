import { describe, expect, it } from 'vitest';
import type { RedisErrorMode } from '../src/stores/redis-store.js';
import {
  RateLimitStrategy,
  type RateLimitOptions,
  type RateLimitStore,
} from '../src/types/index.js';
import {
  VERSION,
  apiGatewayPreset,
  apiKeyHeaderKeyGenerator,
  authEndpointPreset,
  createRateLimiter,
  createRateLimitEngine,
  createStore,
  defaultKeyGenerator,
  detectEnvironment,
  matchingDecrementOptions,
  resolveIncrementOpts,
  expressRateLimiter,
  fixedWindowDefaults,
  Histogram,
  MemoryStore,
  MetricsCounters,
  MetricsManager,
  multiInstancePreset,
  publicApiPreset,
  RedisStore,
  RateLimitEngine,
  singleInstancePreset,
  slidingWindowDefaults,
  tokenBucketDefaults,
} from '../src/index.js';
import type { MetricsConfig, MetricsSnapshot } from '../src/types/index.js';
import defaultExport from '../src/index.js';
import { fastifyRateLimiter } from '../src/fastify.js';

describe('package exports', () => {
  it('exports VERSION string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('exports Express middleware and default', () => {
    expect(typeof expressRateLimiter).toBe('function');
    expect(expressRateLimiter).toBe(defaultExport);
  });

  it('exports createRateLimiter wrapper', () => {
    const out = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(typeof out.express).toBe('function');
  });

  it('exports engine and key generator', () => {
    expect(RateLimitEngine).toBeDefined();
    expect(typeof createRateLimitEngine).toBe('function');
    expect(typeof defaultKeyGenerator).toBe('function');
    expect(typeof resolveIncrementOpts).toBe('function');
    expect(typeof matchingDecrementOptions).toBe('function');
  });

  it('exports stores and factory', () => {
    expect(MemoryStore).toBeDefined();
    expect(RedisStore).toBeDefined();
    expect(typeof createStore).toBe('function');
  });

  it('exports detectEnvironment', () => {
    const env = detectEnvironment();
    expect(env).toMatchObject({
      isCluster: expect.any(Boolean),
      isKubernetes: expect.any(Boolean),
      isDocker: expect.any(Boolean),
      isMultiInstance: expect.any(Boolean),
      recommended: expect.stringMatching(/^(memory|redis)$/),
    });
  });

  it('exports strategy defaults', () => {
    expect(slidingWindowDefaults.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
    expect(fixedWindowDefaults.strategy).toBe(RateLimitStrategy.FIXED_WINDOW);
    expect(tokenBucketDefaults.strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
  });

  it('exports presets', () => {
    expect(typeof singleInstancePreset).toBe('function');
    expect(typeof multiInstancePreset).toBe('function');
    expect(typeof apiGatewayPreset).toBe('function');
    expect(typeof authEndpointPreset).toBe('function');
    expect(typeof publicApiPreset).toBe('function');
    expect(typeof apiKeyHeaderKeyGenerator).toBe('function');
  });

  it('exports Fastify plugin from subpath entry', () => {
    expect(typeof fastifyRateLimiter).toBe('function');
  });

  it('exports MetricsManager and metrics types', () => {
    expect(MetricsManager).toBeDefined();
    expect(MetricsCounters).toBeDefined();
    expect(Histogram).toBeDefined();
    const cfg: MetricsConfig = { enabled: false };
    expect(cfg.enabled).toBe(false);
    const snap = null as MetricsSnapshot | null;
    expect(snap).toBeNull();
  });

  it('RedisErrorMode is a usable string union at compile time', () => {
    const mode: RedisErrorMode = 'fail-open';
    expect(mode).toBe('fail-open');
  });

  it('preset functions return partial options compatible with RateLimitOptions merge', () => {
    const mem = singleInstancePreset() as Partial<RateLimitOptions>;
    expect(mem.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);

    const mockClient: import('../src/stores/redis-store.js').RedisLikeClient = {
      get: async () => null,
      set: async () => 'OK',
      eval: async () => [1, 0, String(Date.now() + 60_000)],
    };
    const redisPartial = multiInstancePreset({ client: mockClient }) as Partial<RateLimitOptions>;
    expect(redisPartial.store).toBeInstanceOf(RedisStore);

    void (redisPartial.store as RateLimitStore).shutdown();
  });
});
