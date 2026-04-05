import { compose } from '../composition/compose.js';
import { RedisStore, type RedisStoreOptions } from '../stores/redis-store.js';
import type { RedisStoreConnectionOptions } from '../utils/store-factory.js';
import type { RateLimitOptions, WindowRateLimitOptions } from '../types/index.js';
import type { RateLimitStore } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';

/**
 * One sliding window slot for {@link multiWindowPreset}.
 *
 * @since 2.0.0
 */
export type MultiWindowRedisWindow = {
  windowMs: number;
  maxRequests: number;
};

/**
 * Steady + burst windows for {@link burstablePreset}.
 *
 * @since 2.0.0
 */
export type BurstableRedisConfig = {
  steady: { windowMs: number; maxRequests: number };
  burst: { windowMs: number; maxRequests: number };
};

/**
 * Labeled store entry for {@link failoverPreset}.
 *
 * @since 2.0.0
 */
export type FailoverPresetStoreEntry = {
  label: string;
  store: RateLimitStore;
};

function redisConn(redisOptions: RedisStoreConnectionOptions): Pick<RedisStoreOptions, 'client' | 'url'> {
  if ('client' in redisOptions && redisOptions.client) {
    return { client: redisOptions.client };
  }
  return { url: redisOptions.url };
}

function redisErrorMode(redisOptions: RedisStoreConnectionOptions): 'fail-open' | 'fail-closed' {
  return redisOptions.onRedisError ?? 'fail-open';
}

/**
 * Multi-window limiting with Redis: **N** {@link RedisStore} sliding windows with **distinct {@link RedisStore} key prefixes**, composed with {@link compose.all} (`all` mode).
 *
 * @description
 * Pass a **shared** `client` when possible to avoid one TCP connection per window. If you only pass `url`, each window opens its own connection to Redis.
 * Top-level `windowMs` / `maxRequests` are the **minimum** across windows (header defaults), matching multi-`limits` behavior.
 * @param redisOptions - `client` or `url`, optional `prefix` (default `rlf:`) and `onRedisError`.
 * @param windows - Non-empty list of `{ windowMs, maxRequests }` (sliding window each).
 * @param options - Optional {@link RateLimitOptions} overrides (merged after defaults).
 * @returns Partial {@link WindowRateLimitOptions} with a {@link ComposedStore} as `store`.
 * @example
 * ```ts
 * app.use(
 *   expressRateLimiter(
 *     multiWindowPreset(
 *       { url: process.env.REDIS_URL! },
 *       [
 *         { windowMs: 1_000, maxRequests: 10 },
 *         { windowMs: 60_000, maxRequests: 100 },
 *         { windowMs: 3_600_000, maxRequests: 1000 },
 *       ],
 *     ),
 *   ),
 * );
 * ```
 * @see {@link compose.all}
 * @since 2.0.0
 */
export function multiWindowPreset(
  redisOptions: RedisStoreConnectionOptions,
  windows: readonly MultiWindowRedisWindow[],
  options?: Partial<WindowRateLimitOptions>,
): Partial<RateLimitOptions> {
  if (!windows.length) {
    throw new Error('multiWindowPreset: `windows` must be a non-empty array');
  }

  const basePrefix = redisOptions.prefix ?? 'rlf:';
  const onRedisError = redisErrorMode(redisOptions);

  const layers = windows.map((w, i) => {
    const keyPrefix = `${basePrefix}mw:${i}:w${w.windowMs}:`;
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: w.windowMs,
      maxRequests: w.maxRequests,
      ...redisConn(redisOptions),
      keyPrefix,
      onRedisError,
    });
    return compose.layer(`limit-${i}`, store);
  });

  const store = compose.all(...layers);
  const minWin = Math.min(...windows.map((w) => w.windowMs));
  const minCap = Math.min(...windows.map((w) => w.maxRequests));

  const base: Partial<WindowRateLimitOptions> = {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: minWin,
    maxRequests: minCap,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    ...options,
    store,
  };

  return base;
}

/**
 * Primary (steady) rate plus burst pool with Redis: two {@link RedisStore} sliding windows composed with {@link compose.overflow}.
 *
 * @description
 * Burst storage is automatically namespaced by {@link ComposedStore} (`burst:` logical suffix on the burst layer). Each store gets its own Redis `keyPrefix` under the shared connection `prefix`.
 * @param redisOptions - `client` or `url`, optional `prefix` and `onRedisError`.
 * @param config - `steady` and `burst` window/max pairs.
 * @param options - Optional {@link RateLimitOptions} overrides.
 * @returns Partial {@link WindowRateLimitOptions} with a {@link ComposedStore} as `store`.
 * @example
 * ```ts
 * app.use(
 *   expressRateLimiter(
 *     burstablePreset(
 *       { url: process.env.REDIS_URL! },
 *       {
 *         steady: { windowMs: 1_000, maxRequests: 5 },
 *         burst: { windowMs: 60_000, maxRequests: 20 },
 *       },
 *     ),
 *   ),
 * );
 * ```
 * @see {@link compose.overflow}
 * @since 2.0.0
 */
export function burstablePreset(
  redisOptions: RedisStoreConnectionOptions,
  config: BurstableRedisConfig,
  options?: Partial<WindowRateLimitOptions>,
): Partial<RateLimitOptions> {
  const basePrefix = redisOptions.prefix ?? 'rlf:';
  const onRedisError = redisErrorMode(redisOptions);

  const steadyStore = new RedisStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: config.steady.windowMs,
    maxRequests: config.steady.maxRequests,
    ...redisConn(redisOptions),
    keyPrefix: `${basePrefix}ov:steady:`,
    onRedisError,
  });

  const burstStore = new RedisStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: config.burst.windowMs,
    maxRequests: config.burst.maxRequests,
    ...redisConn(redisOptions),
    keyPrefix: `${basePrefix}ov:burst:`,
    onRedisError,
  });

  const store = compose.overflow(compose.layer('steady', steadyStore), compose.layer('burst', burstStore));

  const minWin = Math.min(config.steady.windowMs, config.burst.windowMs);
  const minCap = Math.min(config.steady.maxRequests, config.burst.maxRequests);

  const base: Partial<WindowRateLimitOptions> = {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: minWin,
    maxRequests: minCap,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    ...options,
    store,
  };

  return base;
}

/**
 * Try stores in order; first that allows wins ({@link compose.firstAvailable}).
 *
 * @param stores - Non-empty list of `{ label, store }` (labels appear in composed results / metrics).
 * @param options - Optional window defaults and overrides (`windowMs` / `maxRequests` are placeholders for headers unless you override).
 * @returns Partial {@link WindowRateLimitOptions} with a {@link ComposedStore} as `store`.
 * @example
 * ```ts
 * app.use(
 *   expressRateLimiter(
 *     failoverPreset([
 *       { label: 'primary', store: primaryRedis },
 *       { label: 'fallback', store: fallbackMemory },
 *     ]),
 *   ),
 * );
 * ```
 * @see {@link compose.firstAvailable}
 * @since 2.0.0
 */
export function failoverPreset(
  stores: readonly FailoverPresetStoreEntry[],
  options?: Partial<WindowRateLimitOptions>,
): Partial<RateLimitOptions> {
  if (stores.length < 1) {
    throw new Error('failoverPreset: at least one `{ label, store }` entry is required');
  }

  const layers = stores.map((s) => compose.layer(s.label, s.store));
  const store = compose.firstAvailable(...layers);

  const base: Partial<WindowRateLimitOptions> = {
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 100,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    ...options,
    store,
  };

  return base;
}
