import { RedisStore } from '../stores/redis-store.js';
import type { RedisStoreConnectionOptions } from '../utils/store-factory.js';
import type { WindowRateLimitOptions } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import type { NestRateLimitModuleOptions } from './types.js';

/**
 * Basic rate limiting for development / single-process.
 *
 * @example
 * RateLimitModule.forRoot(nestSingleInstancePreset({ maxRequests: 200 }))
 */
export function nestSingleInstancePreset(
  overrides?: Partial<NestRateLimitModuleOptions>,
): NestRateLimitModuleOptions {
  return {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    standardHeaders: 'draft-6',
    ...overrides,
  };
}

/**
 * Production rate limiting with Redis.
 *
 * @example
 * RateLimitModule.forRoot(nestRedisPreset({ url: process.env.REDIS_URL! }))
 */
export function nestRedisPreset(
  redisOptions: RedisStoreConnectionOptions,
  overrides?: Partial<NestRateLimitModuleOptions>,
): NestRateLimitModuleOptions {
  const merged: NestRateLimitModuleOptions = {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    standardHeaders: 'draft-6',
    inMemoryBlock: true,
    ...overrides,
  };

  const win = merged as Partial<WindowRateLimitOptions>;
  const windowMs = win.windowMs ?? 60_000;
  const maxForStore = typeof win.maxRequests === 'number' ? win.maxRequests : 100;

  const store =
    overrides?.store ??
    new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs,
      maxRequests: maxForStore,
      client: redisOptions.client,
      url: redisOptions.url,
      keyPrefix: redisOptions.prefix,
      onRedisError: redisOptions.onRedisError ?? 'fail-open',
    });

  return { ...merged, store };
}

/**
 * Auth endpoint protection — strict limits for login/signup.
 *
 * @description Same defaults as {@link authEndpointPreset} (fixed window, fail-closed Redis). IP keying uses the guard’s default key generator unless you pass `keyGenerator` in overrides. Combine with `@RateLimit()` on auth routes when you need per-route overrides.
 * @example
 * RateLimitModule.forRoot(nestAuthPreset({ url: process.env.REDIS_URL! }))
 */
export function nestAuthPreset(
  redisOptions: RedisStoreConnectionOptions,
  overrides?: Partial<NestRateLimitModuleOptions>,
): NestRateLimitModuleOptions {
  const merged: NestRateLimitModuleOptions = {
    maxRequests: 5,
    windowMs: 60_000,
    strategy: RateLimitStrategy.FIXED_WINDOW,
    standardHeaders: 'draft-6',
    inMemoryBlock: true,
    ...overrides,
  };

  const win = merged as Partial<WindowRateLimitOptions>;
  const windowMs = win.windowMs ?? 60_000;
  const maxForStore = typeof win.maxRequests === 'number' ? win.maxRequests : 5;

  const store =
    overrides?.store ??
    new RedisStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs,
      maxRequests: maxForStore,
      client: redisOptions.client,
      url: redisOptions.url,
      keyPrefix: redisOptions.prefix,
      onRedisError: redisOptions.onRedisError ?? 'fail-closed',
    });

  return { ...merged, store };
}
