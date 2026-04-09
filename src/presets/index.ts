import type { CircuitBreakerOptions } from '../resilience/CircuitBreaker.js';
import type { ResilienceHooks } from '../resilience/types.js';
import type { QueuedRateLimiterOptions } from '../middleware/expressQueuedRateLimiter.js';
import { ClusterStore } from '../stores/ClusterStore.js';
import { MemoryStore } from '../stores/memory-store.js';
import { RedisStore, type RedisStoreOptions } from '../stores/redis-store.js';
import { defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import { ceilDiv, estimateWorkersFromEnvironment } from './estimate-workers.js';
import type { RedisStoreConnectionOptions } from '../utils/store-factory.js';
import type {
  RateLimitOptions,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';

/**
 * Build a rate-limit key from the `x-api-key` header (case variants), falling back to {@link defaultKeyGenerator}.
 *
 * @description Use for gateway-style limits keyed by credential rather than IP.
 * @param req - Framework request with `headers`, or any object compatible with {@link defaultKeyGenerator}.
 * @returns Header value or fallback key string.
 * @example
 * ```ts
 * apiKeyHeaderKeyGenerator({ headers: { 'x-api-key': 'secret' } }); // 'secret'
 * ```
 * @see {@link apiGatewayPreset}
 * @see {@link defaultKeyGenerator}
 * @since 1.2.0
 */
export function apiKeyHeaderKeyGenerator(req: unknown): string {
  if (req !== null && typeof req === 'object') {
    const headers = (req as { headers?: Record<string, unknown> }).headers;
    if (headers && typeof headers === 'object') {
      const raw =
        headers['x-api-key'] ??
        headers['X-API-Key'] ??
        headers['X-Api-Key'] ??
        headers['X-API-KEY'];
      if (typeof raw === 'string' && raw.length > 0) {
        return raw;
      }
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
        return raw[0];
      }
    }
  }
  return defaultKeyGenerator(req);
}

/**
 * First argument to {@link resilientRedisPreset}: Redis connection (`client` or `url`) plus optional {@link RedisStore} tuning.
 * Window or token-bucket fields are merged with the second argument (defaults: sliding window, 60s, 100 req).
 *
 * @since 1.3.2
 */
export type ResilientRedisPresetRedisOptions = RedisStoreConnectionOptions &
  Partial<{
    strategy: RateLimitStrategy;
    windowMs: number;
    maxRequests: number;
    tokensPerInterval: number;
    interval: number;
    bucketSize: number;
  }> &
  Partial<Pick<RedisStoreOptions, 'onWarn' | 'keyPrefix' | 'onRedisError'>>;

function extractStrategyFromRedisOptions(redisOptions: ResilientRedisPresetRedisOptions): Partial<RateLimitOptions> {
  const s = redisOptions.strategy;
  if (s === RateLimitStrategy.TOKEN_BUCKET) {
    return {
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: redisOptions.tokensPerInterval,
      interval: redisOptions.interval,
      bucketSize: redisOptions.bucketSize,
    };
  }
  if (s === RateLimitStrategy.SLIDING_WINDOW || s === RateLimitStrategy.FIXED_WINDOW) {
    return {
      strategy: s,
      windowMs: redisOptions.windowMs,
      maxRequests: redisOptions.maxRequests,
    };
  }
  return {};
}

/**
 * Distributed preset with **insurance** {@link MemoryStore} + circuit breaker around {@link RedisStore}.
 *
 * @description The in-memory store’s cap is `ceil(maxRequests / workers)` so failover traffic stays roughly fair across replicas. Worker count defaults from {@link detectEnvironment} when `estimatedWorkers` is omitted.
 * Sets {@link RateLimitOptionsBase.inMemoryBlock} to **`true`** by default (override with `false` or a config object).
 * @param redisOptions - `client` or `url`, optional `prefix` / `onWarn` / `onRedisError`, optional window overrides.
 * @param options - Rate limit overrides plus `estimatedWorkers`, `hooks`, `circuitBreaker`, `syncOnRecovery`.
 * @returns Partial {@link RateLimitOptions} with a configured {@link RedisStore}.
 * @example
 * ```ts
 * app.use(
 *   expressRateLimiter(
 *     resilientRedisPreset(
 *       { url: process.env.REDIS_URL! },
 *       { maxRequests: 300, estimatedWorkers: 5 },
 *     ),
 *   ),
 * );
 * ```
 * @see {@link multiInstancePreset}
 * @see {@link detectEnvironment}
 * @since 1.3.2
 */
export function resilientRedisPreset(
  redisOptions: ResilientRedisPresetRedisOptions,
  options?: Partial<RateLimitOptions> & {
    estimatedWorkers?: number;
    hooks?: ResilienceHooks;
    circuitBreaker?: Partial<CircuitBreakerOptions>;
    syncOnRecovery?: boolean;
  },
): Partial<RateLimitOptions> {
  const {
    estimatedWorkers,
    hooks,
    circuitBreaker,
    syncOnRecovery,
    ...rateLimitOverrides
  } = options ?? {};

  const merged: Partial<RateLimitOptions> = {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
    ...extractStrategyFromRedisOptions(redisOptions),
    ...rateLimitOverrides,
  };

  const workers = estimateWorkersFromEnvironment(estimatedWorkers);

  const { resilience, ...redisConnectionOnly } = redisOptions as ResilientRedisPresetRedisOptions & {
    resilience?: unknown;
  };
  void resilience;

  const syncFlag = syncOnRecovery !== false;

  if (merged.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const tokensPerInterval = merged.tokensPerInterval ?? 30;
    const interval = merged.interval ?? 60_000;
    const bucketSize = merged.bucketSize ?? 60;

    const insurance = new MemoryStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: ceilDiv(tokensPerInterval, workers),
      interval,
      bucketSize: ceilDiv(bucketSize, workers),
    });

    const store = new RedisStore({
      ...redisConnectionOnly,
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval,
      interval,
      bucketSize,
      resilience: {
        insuranceLimiter: { store: insurance, syncOnRecovery: syncFlag },
        circuitBreaker: circuitBreaker ?? {},
        hooks,
      },
    });

    return { ...merged, store };
  }

  const windowMs =
    merged.strategy === RateLimitStrategy.FIXED_WINDOW ||
    merged.strategy === RateLimitStrategy.SLIDING_WINDOW
      ? (merged.windowMs ?? 60_000)
      : 60_000;
  const maxRequests =
    merged.strategy === RateLimitStrategy.FIXED_WINDOW ||
    merged.strategy === RateLimitStrategy.SLIDING_WINDOW
      ? (typeof merged.maxRequests === 'number' ? merged.maxRequests : 100)
      : 100;
  const strategy =
    merged.strategy === RateLimitStrategy.FIXED_WINDOW
      ? RateLimitStrategy.FIXED_WINDOW
      : RateLimitStrategy.SLIDING_WINDOW;

  const insurance = new MemoryStore({
    strategy,
    windowMs,
    maxRequests: ceilDiv(maxRequests, workers),
  });

  const store = new RedisStore({
    ...redisConnectionOnly,
    strategy,
    windowMs,
    maxRequests,
    resilience: {
      insuranceLimiter: { store: insurance, syncOnRecovery: syncFlag },
      circuitBreaker: circuitBreaker ?? {},
      hooks,
    },
  });

  return { ...merged, store };
}

/**
 * Single-process preset: sliding window, **100 req / minute**, no explicit `store` (middleware creates {@link MemoryStore}).
 *
 * @description For local dev, tests, or a single Node instance.
 * @param options - Overrides merged after defaults (strategy, `windowMs`, `maxRequests`, etc.).
 * @returns Partial {@link RateLimitOptions} suitable for `expressRateLimiter` / `fastifyRateLimiter`.
 * @example
 * ```ts
 * app.use(expressRateLimiter(singleInstancePreset({ maxRequests: 200 })));
 * ```
 * @see {@link multiInstancePreset}
 * @see {@link publicApiPreset}
 * @since 1.2.0
 */
export function singleInstancePreset(
  options: Partial<WindowRateLimitOptions> = {},
): Partial<RateLimitOptions> {
  return {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
    standardHeaders: 'draft-6',
    legacyHeaders: true,
    ...options,
  };
}

/**
 * Node.js **cluster** preset: {@link ClusterStore} on workers (IPC to primary) + defaults aligned with {@link multiInstancePreset} headers.
 *
 * @description Call {@link ClusterStorePrimary.init} once in the **primary** process before workers serve traffic. Each worker builds a {@link ClusterStore} with a unique `keyPrefix` per limiter.
 * @param options - Window or token-bucket overrides plus `keyPrefix` (default `rlf-cluster`) and optional `timeoutMs` for primary IPC replies.
 * @returns Partial {@link RateLimitOptions} with a {@link ClusterStore}.
 * @example
 * ```ts
 * // primary (once):
 * ClusterStorePrimary.init();
 * // worker:
 * app.use(expressRateLimiter(clusterPreset({ maxRequests: 100 })));
 * ```
 * @see {@link ClusterStore}
 * @see {@link ClusterStorePrimary}
 */
export function clusterPreset(
  options?: Partial<RateLimitOptions> & { keyPrefix?: string; timeoutMs?: number },
): Partial<RateLimitOptions> {
  const { keyPrefix = 'rlf-cluster', timeoutMs, ...rest } = options ?? {};
  const strategyHint = (rest as { strategy?: RateLimitStrategy }).strategy;

  if (strategyHint === RateLimitStrategy.TOKEN_BUCKET) {
    const tb = rest as Partial<TokenBucketRateLimitOptions>;
    const merged: Partial<TokenBucketRateLimitOptions> = {
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 30,
      interval: 60_000,
      bucketSize: 60,
      standardHeaders: 'draft-6',
      legacyHeaders: false,
      ...tb,
    };
    const store = new ClusterStore({
      keyPrefix,
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: merged.tokensPerInterval ?? 30,
      interval: merged.interval ?? 60_000,
      bucketSize: merged.bucketSize ?? 60,
      timeoutMs,
    });
    return { ...merged, store };
  }

  const win = rest as Partial<WindowRateLimitOptions>;
  const merged: Partial<WindowRateLimitOptions> = {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    ...win,
  };

  const windowStrategy =
    merged.strategy === RateLimitStrategy.FIXED_WINDOW
      ? RateLimitStrategy.FIXED_WINDOW
      : RateLimitStrategy.SLIDING_WINDOW;

  const store = new ClusterStore({
    keyPrefix,
    strategy: windowStrategy,
    windowMs: merged.windowMs ?? 60_000,
    maxRequests: typeof merged.maxRequests === 'number' ? merged.maxRequests : 100,
    timeoutMs,
  });

  return { ...merged, store };
}

/**
 * Strip fields that only apply to {@link expressQueuedRateLimiter} / {@link fastifyQueuedRateLimiter} before merging into {@link clusterPreset}.
 */
function stripQueuedOnlyFields(
  o?: Partial<QueuedRateLimiterOptions> & { keyPrefix?: string; timeoutMs?: number },
): Partial<RateLimitOptions> {
  if (!o) {
    return {};
  }
  // Extract queue-only fields and return the rest for clusterPreset
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { maxQueueSize, maxQueueTimeMs, keyGenerator, statusCode, message, incrementCost, store, keyPrefix, timeoutMs, ...rateLike } = o;
  return rateLike;
}

/**
 * One-liner for **shared counters across cluster workers** (IPC to primary) **plus queueing** instead of immediate 429.
 *
 * @description Combines {@link clusterPreset} (a {@link ClusterStore}) with queue bounds suitable for {@link expressQueuedRateLimiter} / {@link fastifyQueuedRateLimiter}. Pass `keyPrefix` to namespace the store on the primary (default `rlf-cluster-queued`); the internal queue key prefix defaults to `rlf-queued`.
 * @param options - Window or token-bucket overrides, optional `keyPrefix` / `timeoutMs` for {@link ClusterStore}, plus queued limits (`maxQueueSize`, `maxQueueTimeMs`, etc.).
 * @returns {@link QueuedRateLimiterOptions} ready to pass to {@link expressQueuedRateLimiter} or {@link fastifyQueuedRateLimiter}.
 * @example
 * ```ts
 * app.use(
 *   '/api',
 *   expressQueuedRateLimiter(
 *     queuedClusterPreset({ maxRequests: 100, maxQueueSize: 200, keyPrefix: 'my-app-limiter' }),
 *   ),
 * );
 * ```
 * @see {@link clusterPreset}
 * @see {@link expressQueuedRateLimiter}
 * @since 1.5.0
 */
export function queuedClusterPreset(
  options?: Partial<QueuedRateLimiterOptions> & { keyPrefix?: string; timeoutMs?: number },
): QueuedRateLimiterOptions {
  if (options?.store !== undefined) {
    throw new Error('queuedClusterPreset: omit `store`; a ClusterStore is created automatically');
  }

  const clusterKeyPrefix = options?.keyPrefix ?? 'rlf-cluster-queued';
  const timeoutMs = options?.timeoutMs;

  const c = clusterPreset({
    ...stripQueuedOnlyFields(options),
    keyPrefix: clusterKeyPrefix,
    timeoutMs,
  });

  const store = c.store;
  if (!store) {
    throw new Error('queuedClusterPreset: internal error, expected ClusterStore');
  }

  const maxQueueSize = options?.maxQueueSize ?? 100;
  const maxQueueTimeMs = options?.maxQueueTimeMs ?? 30_000;
  const keyGenerator = options?.keyGenerator;
  const statusCode = options?.statusCode;
  const message = options?.message;
  const incrementCost = options?.incrementCost;
  const standardHeaders = options?.standardHeaders ?? true;
  const legacyHeaders = options?.legacyHeaders ?? false;

  if (c.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const tb = c as Partial<TokenBucketRateLimitOptions>;
    return {
      // Queue uses windowMs for drain timing; map token bucket's interval
      windowMs: tb.interval ?? 60_000,
      maxRequests: tb.bucketSize ?? 60,
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      store,
      maxQueueSize,
      maxQueueTimeMs,
      keyPrefix: 'rlf-queued',
      keyGenerator,
      statusCode,
      message,
      incrementCost,
      standardHeaders,
      legacyHeaders,
    };
  }

  const w = c as Partial<WindowRateLimitOptions>;
  return {
    windowMs: w.windowMs ?? 60_000,
    maxRequests: typeof w.maxRequests === 'number' ? w.maxRequests : 100,
    strategy: w.strategy ?? RateLimitStrategy.SLIDING_WINDOW,
    store,
    maxQueueSize,
    maxQueueTimeMs,
    keyPrefix: 'rlf-queued',
    keyGenerator,
    statusCode,
    message,
    incrementCost,
    standardHeaders,
    legacyHeaders,
  };
}

/**
 * Distributed preset: {@link RedisStore}, sliding window, **100 req / minute**, **`onRedisError`: `fail-open`** by default.
 *
 * @description For PM2 cluster, Kubernetes, or any multi-instance deployment with shared Redis.
 * Sets {@link RateLimitOptionsBase.inMemoryBlock} to **`true`** by default (override with `false` or a config object).
 * @param redisOptions - `client` or `url`, optional `prefix` / `onRedisError`.
 * @param options - Window overrides; pass `store` to replace the built-in {@link RedisStore}.
 * @returns Partial options including a `RedisStore` unless `options.store` is provided.
 * @example
 * ```ts
 * app.use(
 *   expressRateLimiter(
 *     multiInstancePreset({ url: process.env.REDIS_URL! }, { maxRequests: 500 }),
 *   ),
 * );
 * ```
 * @see {@link singleInstancePreset}
 * @see {@link RedisStore}
 * @since 1.2.0
 */
export function multiInstancePreset(
  redisOptions: RedisStoreConnectionOptions,
  options: Partial<WindowRateLimitOptions> = {},
): Partial<RateLimitOptions> {
  const base: Partial<WindowRateLimitOptions> = {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
    ...options,
  };

  const windowMs = base.windowMs ?? 60_000;
  const maxRequests = base.maxRequests;
  const maxForStore = typeof maxRequests === 'number' ? maxRequests : 100;

  const store =
    options.store ??
    new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs,
      maxRequests: maxForStore,
      client: redisOptions.client,
      url: redisOptions.url,
      keyPrefix: redisOptions.prefix,
      onRedisError: redisOptions.onRedisError ?? 'fail-open',
    });

  return { ...base, store };
}

/**
 * API gateway preset: {@link RedisStore}, **token bucket** (~30 tokens/min, burst **60**), {@link apiKeyHeaderKeyGenerator}, **`fail-closed`** when Redis is down by default.
 *
 * @description Stricter availability trade-off: blocks when Redis cannot evaluate limits (HTTP **503**).
 * Sets {@link RateLimitOptionsBase.inMemoryBlock} to **`true`** by default (override with `false` or a config object).
 * @param redisOptions - `client` or `url`, optional `prefix` / `onRedisError`.
 * @param options - Token bucket overrides (`tokensPerInterval`, `interval`, `bucketSize`, `keyGenerator`, etc.).
 * @returns Partial {@link TokenBucketRateLimitOptions}-shaped config with `store`.
 * @example
 * ```ts
 * app.use('/v1', expressRateLimiter(apiGatewayPreset({ url: process.env.REDIS_URL! })));
 * ```
 * @see {@link multiInstancePreset}
 * @see {@link apiKeyHeaderKeyGenerator}
 * @since 1.2.0
 */
export function apiGatewayPreset(
  redisOptions: RedisStoreConnectionOptions,
  options: Partial<TokenBucketRateLimitOptions> = {},
): Partial<RateLimitOptions> {
  const base: Partial<TokenBucketRateLimitOptions> = {
    strategy: RateLimitStrategy.TOKEN_BUCKET,
    tokensPerInterval: 30,
    interval: 60_000,
    bucketSize: 60,
    keyGenerator: apiKeyHeaderKeyGenerator,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: 'api-gateway',
    inMemoryBlock: true,
    ...options,
  };

  const tokensPerInterval = base.tokensPerInterval ?? 30;
  const interval = base.interval ?? 60_000;
  const bucketSize = base.bucketSize ?? 60;

  const store =
    options.store ??
    new RedisStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval,
      interval,
      bucketSize,
      client: redisOptions.client,
      url: redisOptions.url,
      keyPrefix: redisOptions.prefix,
      onRedisError: redisOptions.onRedisError ?? 'fail-closed',
    });

  return { ...base, store };
}

/**
 * Auth endpoint preset: {@link RedisStore}, **fixed window**, **5 req / minute** per IP (default), {@link defaultKeyGenerator}, **`fail-closed`** when Redis is down by default.
 *
 * @description For login/signup/password flows—combine with your auth routes.
 * Sets {@link RateLimitOptionsBase.inMemoryBlock} to **`true`** by default (override with `false` or a config object).
 * @param redisOptions - `client` or `url`, optional `prefix` / `onRedisError`.
 * @param options - Overrides (`maxRequests`, `windowMs`, `keyGenerator`, or custom `store`).
 * @returns Partial window options with `store`.
 * @example
 * ```ts
 * app.post(
 *   '/login',
 *   expressRateLimiter(authEndpointPreset({ url: process.env.REDIS_URL! }, { maxRequests: 10 })),
 *   loginHandler,
 * );
 * ```
 * @see {@link apiGatewayPreset}
 * @see {@link defaultKeyGenerator}
 * @since 1.2.0
 */
export function authEndpointPreset(
  redisOptions: RedisStoreConnectionOptions,
  options: Partial<WindowRateLimitOptions> = {},
): Partial<RateLimitOptions> {
  const base: Partial<WindowRateLimitOptions> = {
    strategy: RateLimitStrategy.FIXED_WINDOW,
    windowMs: 60_000,
    maxRequests: 5,
    keyGenerator: defaultKeyGenerator,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
    ...options,
  };

  const windowMs = base.windowMs ?? 60_000;
  const maxRequests = base.maxRequests;
  const maxForStore = typeof maxRequests === 'number' ? maxRequests : 5;

  const store =
    options.store ??
    new RedisStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs,
      maxRequests: maxForStore,
      client: redisOptions.client,
      url: redisOptions.url,
      keyPrefix: redisOptions.prefix,
      onRedisError: redisOptions.onRedisError ?? 'fail-closed',
    });

  return { ...base, store };
}

/**
 * Public API preset: in-memory sliding window, **60 req / minute**, structured JSON `message` body.
 *
 * @description Omits `store` so middleware builds a {@link MemoryStore}. Override `message` or limits as needed.
 * @param options - Overrides merged after defaults.
 * @returns Partial window options without an explicit Redis `store`.
 * @example
 * ```ts
 * app.use('/public', expressRateLimiter(publicApiPreset()));
 * ```
 * @see {@link singleInstancePreset}
 * @since 1.2.0
 */
export function publicApiPreset(
  options: Partial<WindowRateLimitOptions> = {},
): Partial<RateLimitOptions> {
  return {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: 'Rate limit exceeded',
      retryAfter: '<seconds>',
    },
    ...options,
  };
}

export {
  failClosedPostgresPreset,
  postgresInsuranceMemoryStore,
  postgresPreset,
  resilientPostgresPreset,
  type PostgresPresetPgOptions,
} from './postgres-presets.js';

export { mongoPreset } from './mongo.js';

