import type { RateLimitStore } from '../types/index.js';
import { InMemoryShield } from './InMemoryShield.js';
import type { InMemoryShieldOptions } from './types.js';

/**
 * Wraps a store with in-memory block shielding.
 * Shorthand for `new InMemoryShield(store, options)`.
 *
 * @example
 * ```ts
 * import { shield, RedisStore, expressRateLimiter } from 'ratelimit-flex';
 *
 * const redis = new RedisStore({ url: REDIS_URL, ... });
 * const shielded = shield(redis, { blockOnConsumed: 100 });
 * app.use(expressRateLimiter({ store: shielded, maxRequests: 100 }));
 * ```
 */
export function shield(store: RateLimitStore, options: InMemoryShieldOptions): InMemoryShield {
  return new InMemoryShield(store, options);
}
