/**
 * **ratelimit-flex** — flexible rate limiting for Node.js (Express, Fastify, pluggable stores).
 *
 * @description
 * - Default export: {@link expressRateLimiter}
 * - Fastify: import `fastifyRateLimiter` from `ratelimit-flex/fastify`
 * - Types: re-exported from `./types/index.js`
 * @packageDocumentation
 */

import { expressRateLimiter } from './middleware/express.js';
import type { RateLimitOptions } from './types/index.js';

/**
 * Current package version string (semver).
 *
 * @since 1.0.0
 */
export const VERSION = '1.2.0';

/**
 * Express middleware factory — same implementation as {@link expressRateLimiter} in `./middleware/express.js`.
 *
 * @see {@link expressRateLimiter}
 * @since 1.0.0
 */
export { expressRateLimiter };

/**
 * Core engine, default key extraction, and engine factory.
 *
 * @see {@link RateLimitEngine}
 * @see {@link createRateLimitEngine}
 * @see {@link defaultKeyGenerator}
 * @since 1.0.0
 */
export {
  RateLimitEngine,
  createRateLimiter as createRateLimitEngine,
  defaultKeyGenerator,
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
export { detectEnvironment, type EnvironmentInfo } from './utils/environment.js';

/**
 * Merged default option objects per strategy (`slidingWindowDefaults`, `fixedWindowDefaults`, `tokenBucketDefaults`).
 *
 * @since 1.0.0
 */
export { fixedWindowDefaults, slidingWindowDefaults, tokenBucketDefaults } from './strategies/defaults.js';

/**
 * All shared TypeScript types and {@link RateLimitStrategy}.
 *
 * @since 1.0.0
 */
export * from './types/index.js';
export { RateLimitStrategy } from './types/index.js';

/**
 * Opinionated {@link RateLimitOptions} builders for common deployments.
 *
 * @since 1.2.0
 */
export {
  apiGatewayPreset,
  apiKeyHeaderKeyGenerator,
  authEndpointPreset,
  multiInstancePreset,
  publicApiPreset,
  singleInstancePreset,
} from './presets/index.js';

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
export function createRateLimiter(options: Partial<RateLimitOptions>) {
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
