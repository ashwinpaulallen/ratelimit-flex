/**
 * **ratelimit-flex** — flexible rate limiting for Node.js (Express, Fastify, pluggable stores).
 *
 * @description
 * - Default export: {@link expressRateLimiter}
 * - Queued limits: {@link expressQueuedRateLimiter}, {@link createRateLimiterQueue}, {@link RateLimiterQueue}
 * - Fastify: import `fastifyRateLimiter` / `fastifyQueuedRateLimiter` from `ratelimit-flex/fastify`
 * - Types: re-exported from `./types/index.js`
 * - Resilience: {@link CircuitBreaker}, {@link RedisResilienceOptions}, {@link resilientRedisPreset}, related types
 * @packageDocumentation
 */

import { expressRateLimiter, type ExpressRateLimiterHandler } from './middleware/express.js';
import type { RateLimitOptions } from './types/index.js';

/**
 * Current package version string (semver). Same as **`package.json`** **`version`** (single source of truth).
 *
 * @since 1.0.0
 */
export { VERSION } from './version.js';

/**
 * Express middleware factory — same implementation as {@link expressRateLimiter} in `./middleware/express.js`.
 *
 * @see {@link expressRateLimiter}
 * @since 1.0.0
 */
export { expressRateLimiter, type ExpressRateLimiterHandler } from './middleware/express.js';

export {
  assertHistogramBucketBounds,
  CallbackAdapter,
  Histogram,
  MetricsCollector,
  MetricsCounters,
  MetricsManager,
  OpenTelemetryAdapter,
  PrometheusAdapter,
  createMetricsCountersIfEnabled,
  normalizeMetricsConfig,
  type OpenTelemetryAdapterOptions,
  type PrometheusAdapterOptions,
} from './metrics/index.js';

/**
 * Core engine, default key extraction, and engine factory.
 *
 * @see {@link RateLimitEngine}
 * @see {@link createRateLimitEngine}
 * @see {@link defaultKeyGenerator}
 * @see {@link resolveIncrementOpts} — per-request `increment` options (dynamic `maxRequests`, `incrementCost`)
 * @see {@link matchingDecrementOptions} — `decrement` options that match a prior increment
 * @since 1.0.0
 */
export {
  RateLimitEngine,
  createRateLimiter as createRateLimitEngine,
  defaultKeyGenerator,
  matchingDecrementOptions,
  resolveIncrementOpts,
  type RateLimitConsumeResult,
  type RateLimiterConfigInput,
} from './strategies/rate-limit-engine.js';

/**
 * In-memory {@link MemoryStore} implementation.
 *
 * @since 1.0.0
 */
export { MemoryStore } from './stores/memory-store.js';

/**
 * Redis-backed {@link RedisStore} and error mode type.
 *
 * @since 1.0.0
 */
export { RedisStore, type RedisErrorMode } from './stores/redis-store.js';

/**
 * Store factory and Redis connection types for programmatic store creation.
 *
 * @see {@link createStore}
 * @since 1.2.0
 */
export {
  createStore,
  type CreateStoreOptions,
  type RedisStoreConnectionOptions,
} from './utils/store-factory.js';

/**
 * Deployment detection and MemoryStore warning helper.
 *
 * @see {@link detectEnvironment}
 * @since 1.2.0
 */
export {
  detectEnvironment,
  isPm2ManagedProcess,
  type EnvironmentInfo,
} from './utils/environment.js';

/**
 * Merged default option objects per strategy (`slidingWindowDefaults`, `fixedWindowDefaults`, `tokenBucketDefaults`).
 *
 * @since 1.0.0
 */
export { fixedWindowDefaults, slidingWindowDefaults, tokenBucketDefaults } from './strategies/defaults.js';

/**
 * Resilience: {@link CircuitBreaker}, {@link CircuitBreakerOptions}, {@link ResilienceHooks}, {@link InsuranceLimiterOptions}, {@link RedisResilienceOptions}, {@link CircuitState}.
 *
 * @since 1.3.2
 */
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  type InsuranceLimiterOptions,
  type RedisResilienceOptions,
  type ResilienceHooks,
} from './resilience/index.js';

/**
 * Standalone {@link RateLimiterQueue} factory for non-HTTP workloads (outbound APIs, jobs, crawlers).
 *
 * @see {@link createRateLimiterQueue}
 * @since 1.4.2
 */
export {
  createRateLimiterQueue,
  type CreateRateLimiterQueueOptions,
} from './queue/createRateLimiterQueue.js';
export {
  RateLimiterQueue,
  RateLimiterQueueError,
  type RateLimiterQueueErrorCode,
  type RateLimiterQueueOptions,
  type RateLimiterQueueResult,
} from './queue/RateLimiterQueue.js';

/**
 * Express middleware that **queues** over-limit requests instead of responding with 429 immediately.
 *
 * @see {@link expressQueuedRateLimiter}
 * @since 1.5.0
 */
export { expressQueuedRateLimiter } from './middleware/expressQueuedRateLimiter.js';

/**
 * All shared TypeScript types and {@link RateLimitStrategy}.
 *
 * @since 1.0.0
 */
export * from './types/index.js';
export { RateLimitStrategy } from './types/index.js';

/**
 * Pure rate-limit HTTP header formatting (no framework deps). Also re-exports {@link StandardHeadersDraft} for typing `standardHeaders`.
 *
 * @see {@link formatRateLimitHeaders} — build headers for custom middleware
 * @see {@link resolveHeaderConfig} — resolve profile + default identifier from options
 * @since 1.4.0
 */
export {
  defaultRateLimitIdentifier,
  formatRateLimitHeaders,
  resolveHeaderConfig,
  resolveWindowMsForHeaders,
  sanitizeIdentifierFor8941,
  type HeaderFormat,
  type HeaderInput,
  type HeaderOutput,
  type ResolvedHeaderConfig,
  type StandardHeadersDraft,
} from './headers/index.js';

/**
 * Migration helpers (e.g. from `express-rate-limit`).
 *
 * @since 1.4.0
 */
export { fromExpressRateLimitOptions, type ExpressRateLimitLikeOptions } from './compat/expressRateLimitCompat.js';

/**
 * Opinionated {@link RateLimitOptions} builders for common deployments.
 *
 * @since 1.2.0
 */
export {
  apiGatewayPreset,
  apiKeyHeaderKeyGenerator,
  authEndpointPreset,
  clusterPreset,
  multiInstancePreset,
  publicApiPreset,
  queuedClusterPreset,
  resilientRedisPreset,
  singleInstancePreset,
  type ResilientRedisPresetRedisOptions,
} from './presets/index.js';

/**
 * Node.js native `cluster`: {@link ClusterStore} (workers), {@link ClusterStorePrimary} (primary), IPC protocol types.
 * Pair with {@link clusterPreset} for Express/Fastify options.
 *
 * @see {@link clusterPreset}
 * @since 1.4.2
 */
export { ClusterStore, type ClusterStoreOptions } from './stores/ClusterStore.js';
export {
  ClusterStorePrimary,
  type ClusterPrimaryMessage,
  type ClusterStoreInitOptions,
  type ClusterWorkerMessage,
  isRateLimitFlexMessage,
} from './cluster/index.js';

/**
 * Returns `{ express }` where `express` is {@link expressRateLimiter} bound to the given options.
 *
 * @param options - Partial {@link RateLimitOptions} (same as middleware).
 * @returns Object with an `express` property (Express `RequestHandler`).
 * @example
 * ```ts
 * const { express } = createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
 * app.use(express);
 * ```
 * @see {@link expressRateLimiter}
 * @since 1.0.0
 */
export function createRateLimiter(options: Partial<RateLimitOptions>): {
  express: ExpressRateLimiterHandler;
} {
  return {
    express: expressRateLimiter(options),
  };
}

/**
 * Default export: Express rate limit middleware ({@link expressRateLimiter}).
 *
 * @example
 * ```ts
 * import rateLimit from 'ratelimit-flex';
 * app.use(rateLimit({ maxRequests: 100, windowMs: 60_000 }));
 * ```
 * @see {@link expressRateLimiter}
 * @since 1.0.0
 */
export default expressRateLimiter;
