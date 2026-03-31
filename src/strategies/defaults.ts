import { RateLimitStrategy } from '../types/index.js';

/**
 * Default numbers merged for sliding-window configs (middleware may synthesize a {@link MemoryStore} when `store` is omitted).
 *
 * @see {@link MemoryStore}
 * @since 1.0.0
 */
export const slidingWindowDefaults = {
  /** @description {@link RateLimitStrategy.SLIDING_WINDOW} */
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  /** @description Window length in milliseconds. @default 60000 */
  windowMs: 60_000,
  /** @description Max requests per window. @default 100 */
  maxRequests: 100,
} as const;

/**
 * Default numbers merged for fixed-window configs.
 *
 * @since 1.0.0
 */
export const fixedWindowDefaults = {
  /** @description {@link RateLimitStrategy.FIXED_WINDOW} */
  strategy: RateLimitStrategy.FIXED_WINDOW,
  /** @description Window length in milliseconds. @default 60000 */
  windowMs: 60_000,
  /** @description Max requests per window. @default 100 */
  maxRequests: 100,
} as const;

/**
 * Default numbers merged for token-bucket configs. Burst size is {@link tokenBucketDefaults.bucketSize}, not `maxRequests`.
 *
 * @since 1.0.0
 */
export const tokenBucketDefaults = {
  /** @description {@link RateLimitStrategy.TOKEN_BUCKET} */
  strategy: RateLimitStrategy.TOKEN_BUCKET,
  /** @description Tokens added per `interval`. @default 10 */
  tokensPerInterval: 10,
  /** @description Refill interval in milliseconds. @default 60000 */
  interval: 60_000,
  /** @description Max tokens (burst). @default 100 */
  bucketSize: 100,
} as const;
