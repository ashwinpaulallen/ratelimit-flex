import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RedisErrorMode } from '../src/stores/redis-store.js';
import {
  RateLimitStrategy,
  type RateLimitOptions,
  type RateLimitStore,
} from '../src/types/index.js';
import type {
  CircuitBreakerOptions,
  HeaderFormat,
  HeaderInput,
  HeaderOutput,
  InsuranceLimiterOptions,
  RedisResilienceOptions,
  ResilienceHooks,
  StandardHeadersDraft,
} from '../src/index.js';
import {
  CircuitBreaker,
  VERSION,
  apiGatewayPreset,
  apiKeyHeaderKeyGenerator,
  authEndpointPreset,
  burstablePreset,
  clusterPreset,
  CLUSTER_IPC_PROTOCOL_VERSION,
  MIN_CLUSTER_IPC_PROTOCOL_VERSION,
  failoverPreset,
  ClusterStore,
  ClusterStorePrimary,
  COMPOSED_STORE_BRAND,
  COMPOSED_UNWRAP,
  ComposedStore,
  compose,
  createRateLimiter,
  createRateLimiterQueue,
  createRateLimitEngine,
  KeyedRateLimiterQueue,
  expressQueuedRateLimiter,
  createStore,
  defaultKeyGenerator,
  defaultRateLimitIdentifier,
  detectEnvironment,
  formatRateLimitHeaders,
  matchingDecrementOptions,
  resolveHeaderConfig,
  resolveIncrementOpts,
  expressRateLimiter,
  fixedWindowDefaults,
  Histogram,
  InMemoryShield,
  MemoryStore,
  MetricsCounters,
  MetricsManager,
  multiInstancePreset,
  multiWindowPreset,
  publicApiPreset,
  queuedClusterPreset,
  RedisStore,
  resilientRedisPreset,
  RateLimitEngine,
  RateLimiterQueue,
  RateLimiterQueueError,
  singleInstancePreset,
  shield,
  slidingWindowDefaults,
  tokenBucketDefaults,
  isComposedStoreBrand,
  isRateLimitFlexMessage,
  registerComposedStoreFacade,
  unregisterComposedStoreFacade,
} from '../src/index.js';
import type { MetricsConfig, MetricsSnapshot } from '../src/types/index.js';
import defaultExport from '../src/index.js';
import { fastifyQueuedRateLimiter, fastifyRateLimiter } from '../src/fastify.js';
import { queuedRateLimiter, rateLimiter, webSocketLimiter } from '../src/hono/index.js';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('package exports', () => {
  it('exports VERSION string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('VERSION matches package.json (sync-version / build must stay aligned)', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('exports Express middleware and default', () => {
    expect(typeof expressRateLimiter).toBe('function');
    expect(expressRateLimiter).toBe(defaultExport);
  });

  it('exports createRateLimiter wrapper', () => {
    const out = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(typeof out.express).toBe('function');
  });

  it('exports createRateLimiterQueue for non-HTTP use', () => {
    expect(typeof createRateLimiterQueue).toBe('function');
    const q = createRateLimiterQueue({ maxRequests: 1, windowMs: 60_000 });
    expect(typeof q.removeTokens).toBe('function');
    q.shutdown();
  });

  it('exports KeyedRateLimiterQueue', () => {
    expect(typeof KeyedRateLimiterQueue).toBe('function');
    const k = new KeyedRateLimiterQueue({ maxRequests: 1, windowMs: 60_000, maxKeys: 2 });
    expect(typeof k.forKey).toBe('function');
    k.shutdown();
  });

  it('exports expressQueuedRateLimiter and RateLimiterQueue surface', () => {
    expect(typeof expressQueuedRateLimiter).toBe('function');
    expect(typeof RateLimiterQueue).toBe('function');
    expect(typeof RateLimiterQueueError).toBe('function');
    
    // Verify error code type is exported (compile-time check via usage)
    const err = new RateLimiterQueueError('test', 'queue_full');
    expect(err.code).toBe('queue_full');
  });

  it('exports engine and key generator', () => {
    expect(RateLimitEngine).toBeDefined();
    expect(typeof createRateLimitEngine).toBe('function');
    expect(typeof defaultKeyGenerator).toBe('function');
    expect(typeof resolveIncrementOpts).toBe('function');
    expect(typeof matchingDecrementOptions).toBe('function');
  });

  it('exports CircuitBreaker', () => {
    expect(CircuitBreaker).toBeDefined();
    expect(new CircuitBreaker().state).toBe('CLOSED');
  });

  it('exports InMemoryShield and shield', () => {
    expect(InMemoryShield).toBeDefined();
    expect(typeof shield).toBe('function');
  });

  it('shield() return type is InMemoryShield (RateLimitStore + shield helpers)', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    try {
      const shielded = shield(store, { blockOnConsumed: 10 });
      expectTypeOf(shielded).toEqualTypeOf<InMemoryShield>();
      expectTypeOf(shielded.increment).toBeFunction();
      expectTypeOf(shielded.getMetrics).toBeFunction();
      expectTypeOf(shielded.isShielded).toBeFunction();
      expectTypeOf(shielded.getShieldedKeys).toBeFunction();
      expectTypeOf(shielded.unshield).toBeFunction();
      expectTypeOf(shielded.clearShield).toBeFunction();
      expectTypeOf(shielded.sweep).toBeFunction();
    } finally {
      await store.shutdown();
    }
  });

  it('exports resilience-related types (compile-time re-exports from main entry)', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    try {
      const _hooks: ResilienceHooks = {};
      const _insurance: InsuranceLimiterOptions = { store };
      const _resilience: RedisResilienceOptions = {
        insuranceLimiter: _insurance,
        circuitBreaker: { failureThreshold: 2 } satisfies Partial<CircuitBreakerOptions>,
      };
      void _hooks;
      void _resilience;
      expect(_resilience.insuranceLimiter?.store).toBe(store);
    } finally {
      await store.shutdown();
    }
  });

  it('exports composed-store brand helpers', () => {
    expect(typeof COMPOSED_STORE_BRAND).toBe('symbol');
    expect(typeof COMPOSED_UNWRAP).toBe('symbol');
    expect(typeof isComposedStoreBrand).toBe('function');
    expect(typeof registerComposedStoreFacade).toBe('function');
    expect(typeof unregisterComposedStoreFacade).toBe('function');
  });

  it('exports stores and factory', () => {
    expect(MemoryStore).toBeDefined();
    expect(RedisStore).toBeDefined();
    expect(ComposedStore).toBeDefined();
    expect(typeof compose.all).toBe('function');
    expect(typeof compose.layer).toBe('function');
    expect(typeof createStore).toBe('function');
    expect(typeof multiWindowPreset).toBe('function');
    expect(typeof burstablePreset).toBe('function');
    expect(typeof failoverPreset).toBe('function');
  });

  it('exports detectEnvironment', () => {
    const env = detectEnvironment();
    expect(env).toMatchObject({
      isCluster: expect.any(Boolean),
      isNativeCluster: expect.any(Boolean),
      isKubernetes: expect.any(Boolean),
      isDocker: expect.any(Boolean),
      isMultiInstance: expect.any(Boolean),
      recommended: expect.stringMatching(/^(memory|redis|cluster)$/),
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
    expect(typeof resilientRedisPreset).toBe('function');
    expect(typeof clusterPreset).toBe('function');
    expect(typeof queuedClusterPreset).toBe('function');
    expect(typeof apiKeyHeaderKeyGenerator).toBe('function');
  });

  it('exports ClusterStorePrimary', () => {
    expect(ClusterStorePrimary).toBeDefined();
    expect(typeof ClusterStorePrimary.init).toBe('function');
  });

  it('exports ClusterStore and cluster IPC helpers', () => {
    expect(ClusterStore).toBeDefined();
    expect(CLUSTER_IPC_PROTOCOL_VERSION).toBe(1);
    expect(MIN_CLUSTER_IPC_PROTOCOL_VERSION).toBe(1);
    expect(typeof isRateLimitFlexMessage).toBe('function');
    expect(
      isRateLimitFlexMessage({
        channel: 'rate_limiter_flex',
        type: 'init_ack',
        keyPrefix: 'p',
      }),
    ).toBe(true);
  });

  it('exports Fastify plugin from subpath entry', () => {
    expect(typeof fastifyRateLimiter).toBe('function');
    expect(typeof fastifyQueuedRateLimiter).toBe('function');
  });

  it('exports Hono middleware from subpath entry', () => {
    expect(typeof rateLimiter).toBe('function');
    expect(typeof queuedRateLimiter).toBe('function');
    expect(typeof webSocketLimiter).toBe('function');
  });

  it('exports honoDefaultKeyGenerator from Hono subpath', async () => {
    const { honoDefaultKeyGenerator } = await import('../src/hono/index.js');
    expect(typeof honoDefaultKeyGenerator).toBe('function');
  });

  it('exports HONO_RATE_LIMIT_INCREMENT_COST from Hono subpath', async () => {
    const { HONO_RATE_LIMIT_INCREMENT_COST } = await import('../src/hono/index.js');
    expect(HONO_RATE_LIMIT_INCREMENT_COST).toBe('ratelimitFlex:incrementCost');
  });

  it('exports resolvedHonoRollbackStatus from Hono subpath', async () => {
    const { resolvedHonoRollbackStatus } = await import('../src/hono/index.js');
    expect(typeof resolvedHonoRollbackStatus).toBe('function');
  });

  it('Hono rateLimiter returns HonoRateLimiterHandler with metrics support', () => {
    const limiter = rateLimiter({ maxRequests: 10, windowMs: 60_000 });
    expect(typeof limiter).toBe('function');
    expect(limiter.metricsManager).toBeDefined();
    expect(typeof limiter.getMetricsSnapshot).toBe('function');
    expect(typeof limiter.getMetricsHistory).toBe('function');
    expect(typeof limiter.shutdown).toBe('function');
  });

  it('Hono queuedRateLimiter returns handler with queue and metrics surface', () => {
    const mw = queuedRateLimiter({ maxRequests: 10, windowMs: 60_000, standardHeaders: false });
    expect(typeof mw).toBe('function');
    expect(mw.queue).toBeDefined();
    expect(mw.metricsManager).toBeDefined();
    expect(typeof mw.getMetricsSnapshot).toBe('function');
    expect(typeof mw.shutdown).toBe('function');
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

  it('exports header APIs and types for custom middleware', async () => {
    expect(typeof formatRateLimitHeaders).toBe('function');
    expect(typeof resolveHeaderConfig).toBe('function');
    expect(typeof defaultRateLimitIdentifier).toBe('function');
    const draft: StandardHeadersDraft = 'draft-6';
    const fmt: HeaderFormat = 'legacy';
    const input: HeaderInput = {
      limit: 10,
      remaining: 5,
      resetTime: new Date(),
      isBlocked: false,
      windowMs: 60_000,
      identifier: '10-per-60',
    };
    const out = formatRateLimitHeaders(input, fmt, false);
    expect(out.headers['X-RateLimit-Limit']).toBe('10');
    const merged = mergeRateLimiterOptions({ maxRequests: 10, windowMs: 60_000 });
    try {
      const cfg = resolveHeaderConfig(merged);
      expect(cfg.format).toBe('legacy');
    } finally {
      await merged.store.shutdown();
    }
    const _hdr: HeaderOutput = out;
    void draft;
    void _hdr;
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
