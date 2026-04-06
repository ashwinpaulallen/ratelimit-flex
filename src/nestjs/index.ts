/**
 * **NestJS entry** — `RateLimitModule`, `RateLimitGuard`, decorators, and presets.
 *
 * @description Import from `ratelimit-flex/nestjs` so Nest-specific code stays separate from the main bundle.
 */
export { RateLimitModule, RATE_LIMIT_MODULE_INIT, type RateLimitModuleInit } from './RateLimitModule.js';
export { RateLimitGuard } from './RateLimitGuard.js';
export { RateLimit, SkipRateLimit } from './decorators.js';
export {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  RATE_LIMIT_KEY_MANAGER,
  RATE_LIMIT_SHIELD,
  RATE_LIMIT_METRICS,
  RATE_LIMIT_METADATA,
  RATE_LIMIT_SKIP_METADATA,
} from './types.js';
export type { NestRateLimitModuleOptions, RateLimitDecoratorOptions } from './types.js';
export { nestSingleInstancePreset, nestRedisPreset, nestAuthPreset } from './presets.js';
export { tryResolveGraphqlRequestResponse, type NodeRequireFn } from './resolve-graphql-req-res.js';
