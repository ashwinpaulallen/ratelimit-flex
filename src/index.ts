/**
 * ratelimit-flex — flexible rate limiting for Node.js
 */

import { expressRateLimiter } from './middleware/express.js';
import type { RateLimitOptions } from './types/index.js';

export const VERSION = '1.1.0';

// Framework adapters (Fastify: `import { fastifyRateLimiter } from 'ratelimit-flex/fastify'`)
export { expressRateLimiter };

// Core engine and stores
export {
  RateLimitEngine,
  createRateLimiter as createRateLimitEngine,
  defaultKeyGenerator,
  type RateLimitConsumeResult,
  type RateLimiterConfigInput,
} from './strategies/rate-limit-engine.js';
export { MemoryStore } from './stores/memory-store.js';
export { RedisStore, type RedisErrorMode } from './stores/redis-store.js';

// Built-in defaults
export { fixedWindowDefaults, slidingWindowDefaults, tokenBucketDefaults } from './strategies/defaults.js';

// Shared types and enums
export * from './types/index.js';
export { RateLimitStrategy } from './types/index.js';

/**
 * Convenience factory that returns Express middleware.
 *
 * For Fastify, use `import { fastifyRateLimiter } from 'ratelimit-flex/fastify'`.
 *
 * Usage:
 * ```ts
 * const limiter = createRateLimiter({ maxRequests: 100 });
 * app.use(limiter.express);
 * ```
 */
export function createRateLimiter(options: Partial<RateLimitOptions>) {
  return {
    express: expressRateLimiter(options),
  };
}

// Express is the most common default integration path.
export default expressRateLimiter;
