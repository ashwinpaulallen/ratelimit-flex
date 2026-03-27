/**
 * ratelimit-flex — flexible rate limiting for Node.js
 */

import { expressRateLimiter } from './middleware/express.js';
import { fastifyRateLimiter } from './middleware/fastify.js';
import type { RateLimitOptions } from './types/index.js';
import fp from 'fastify-plugin';

export const VERSION = '0.1.0';

// Framework adapters
export { expressRateLimiter, fastifyRateLimiter };

// Core engine and stores
export {
  RateLimitEngine,
  createRateLimiter as createRateLimitEngine,
  defaultKeyGenerator,
  type RateLimitConsumeResult,
  type RateLimiterConfigInput,
} from './strategies/rate-limit-engine.js';
export { MemoryStore } from './stores/memory-store.js';
export { RedisStore } from './stores/redis-store.js';

// Built-in defaults
export { fixedWindowDefaults, slidingWindowDefaults, tokenBucketDefaults } from './strategies/defaults.js';

// Shared types and enums
export * from './types/index.js';
export { RateLimitStrategy } from './types/index.js';

/**
 * Convenience factory that returns both Express middleware and Fastify plugin.
 *
 * Usage:
 * ```ts
 * const limiter = createRateLimiter({ maxRequests: 100 });
 * app.use(limiter.express);           // Express
 * await app.register(limiter.fastify); // Fastify
 * ```
 *
 * Prefer importing `expressRateLimiter` or `fastifyRateLimiter` directly when framework is known.
 */
export function createRateLimiter(options: Partial<RateLimitOptions>) {
  const wrappedPlugin = fp(
    async (fastify: unknown, pluginOpts: Partial<RateLimitOptions> = {}) => {
      const merged = { ...options, ...pluginOpts };
      return (fastifyRateLimiter as unknown as (f: unknown, o: Partial<RateLimitOptions>) => Promise<void>)(
        fastify,
        merged,
      );
    },
    { name: 'ratelimit-flex-wrapper' },
  );

  return {
    express: expressRateLimiter(options),
    fastify: wrappedPlugin as typeof fastifyRateLimiter,
  };
}

// Express is the most common default integration path.
export default expressRateLimiter;
