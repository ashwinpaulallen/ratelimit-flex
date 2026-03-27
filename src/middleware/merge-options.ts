import { MemoryStore } from '../stores/memory-store.js';
import {
  fixedWindowDefaults,
  slidingWindowDefaults,
  tokenBucketDefaults,
} from '../strategies/defaults.js';
import type { RateLimitInfo, RateLimitOptions, RateLimitResult } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';

export const baseDefaults = {
  headers: true,
  statusCode: 429,
  message: 'Too many requests',
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
} as const;

export function getLimit(opts: RateLimitOptions): number {
  if (opts.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return opts.bucketSize;
  }
  return opts.maxRequests ?? 100;
}

/**
 * Merge partial options with strategy defaults and ensure a {@link MemoryStore} when `store` is omitted.
 */
export function mergeRateLimiterOptions(options: Partial<RateLimitOptions>): RateLimitOptions {
  const strategy = options.strategy ?? RateLimitStrategy.SLIDING_WINDOW;

  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const merged = {
      ...tokenBucketDefaults,
      ...baseDefaults,
      ...options,
      strategy: RateLimitStrategy.TOKEN_BUCKET as const,
    };
    const store =
      merged.store ??
      new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: merged.tokensPerInterval,
        interval: merged.interval,
        bucketSize: merged.bucketSize,
      });
    return { ...merged, store };
  }

  const windowDefaults =
    strategy === RateLimitStrategy.FIXED_WINDOW ? fixedWindowDefaults : slidingWindowDefaults;

  const merged = {
    ...windowDefaults,
    ...baseDefaults,
    ...options,
    strategy,
  };

  const store =
    merged.store ??
    new MemoryStore({
      strategy: merged.strategy,
      windowMs: merged.windowMs ?? 60_000,
      maxRequests: merged.maxRequests ?? 100,
    });

  return { ...merged, store };
}

export function toRateLimitInfo(opts: RateLimitOptions, result: RateLimitResult): RateLimitInfo {
  return {
    limit: getLimit(opts),
    current: result.totalHits,
    remaining: result.remaining,
    resetTime: result.resetTime,
  };
}

export function jsonErrorBody(message: string | object): object {
  return { error: message };
}
