import { MemoryStore } from '../stores/memory-store.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';
import {
  fixedWindowDefaults,
  slidingWindowDefaults,
  tokenBucketDefaults,
} from '../strategies/defaults.js';
import type {
  RateLimitInfo,
  RateLimitOptions,
  RateLimitResult,
  WindowLimitSpec,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { validateRateLimitHeaderOptions } from './validate-header-options.js';

export const baseDefaults = {
  headers: true,
  statusCode: 429,
  message: 'Too many requests',
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
} as const;

export function getLimit(opts: RateLimitOptions, req?: unknown): number {
  if (opts.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return opts.bucketSize;
  }
  const w = opts as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    return Math.min(...w.groupedWindowStores.map((g) => g.maxRequests));
  }
  const mr = w.maxRequests ?? 100;
  if (typeof mr === 'function') {
    return req !== undefined ? sanitizeRateLimitCap(mr(req), 100) : 100;
  }
  return sanitizeRateLimitCap(mr, 100);
}

/**
 * Merge partial options with strategy defaults and ensure a {@link MemoryStore} when `store` is omitted.
 */
export function mergeRateLimiterOptions(options: Partial<RateLimitOptions>): RateLimitOptions {
  validateRateLimitHeaderOptions(options);
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

  const limits = (merged as WindowRateLimitOptions).limits;
  if (limits && limits.length > 0) {
    const groupedWindowStores = limits.map((entry: WindowLimitSpec) => {
      const windowMs = sanitizeWindowMs(entry.windowMs, 60_000);
      const maxRequests = sanitizeRateLimitCap(entry.max, 100);
      return {
        windowMs,
        maxRequests,
        store: new MemoryStore({
          strategy: merged.strategy,
          windowMs,
          maxRequests,
        }),
      };
    });
    const store = groupedWindowStores[0]!.store;
    return { ...merged, groupedWindowStores, store };
  }

  const maxForStore = typeof merged.maxRequests === 'number' ? merged.maxRequests : 100;

  const store =
    merged.store ??
    new MemoryStore({
      strategy: merged.strategy,
      windowMs: merged.windowMs ?? 60_000,
      maxRequests: maxForStore,
    });

  return { ...merged, store };
}

export function toRateLimitInfo(
  opts: RateLimitOptions,
  result: RateLimitResult,
  req?: unknown,
): RateLimitInfo {
  return {
    limit: getLimit(opts, req),
    current: result.totalHits,
    remaining: result.remaining,
    resetTime: result.resetTime,
  };
}

export function jsonErrorBody(message: string | object): object {
  return { error: message };
}
