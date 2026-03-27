import { RateLimitStrategy } from '../types/index.js';

/**
 * Sensible defaults for sliding-window rate limiting (no {@link RateLimitOptionsBase.store} — pass a store or use {@link createRateLimiter}).
 */
export const slidingWindowDefaults = {
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
} as const;

/**
 * Sensible defaults for fixed-window rate limiting.
 */
export const fixedWindowDefaults = {
  strategy: RateLimitStrategy.FIXED_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
} as const;

/**
 * Sensible defaults for token-bucket rate limiting.
 * Use {@link TokenBucketRateLimitOptions.bucketSize} for burst capacity (not `maxRequests`).
 */
export const tokenBucketDefaults = {
  strategy: RateLimitStrategy.TOKEN_BUCKET,
  tokensPerInterval: 10,
  interval: 60_000,
  bucketSize: 100,
} as const;
