import { RedisStore } from '../stores/redis-store.js';
import { defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
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
    ...options,
  };
}

/**
 * Distributed preset: {@link RedisStore}, sliding window, **100 req / minute**, **`onRedisError`: `fail-open`** by default.
 *
 * @description For PM2 cluster, Kubernetes, or any multi-instance deployment with shared Redis.
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
    message: {
      error: 'Rate limit exceeded',
      retryAfter: '<seconds>',
    },
    ...options,
  };
}
