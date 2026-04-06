import { SetMetadata } from '@nestjs/common';
import {
  RATE_LIMIT_METADATA,
  RATE_LIMIT_SKIP_METADATA,
  type RateLimitDecoratorOptions,
} from './types.js';

/**
 * Override rate limit settings for a specific controller or route.
 *
 * @remarks
 * Only **single-window** overrides are supported here. For multiple windows (e.g. per-second + per-minute),
 * configure `limits` / a composed `store` on `RateLimitModule.forRoot(...)`.
 *
 * @example
 * // On a controller — all routes get these settings
 * @RateLimit({ maxRequests: 5, windowMs: 60_000 })
 * @Controller('auth')
 * export class AuthController { ... }
 *
 * // On a single route
 * @RateLimit({ maxRequests: 1, windowMs: 1000, cost: 5 })
 * @Post('login')
 * async login() { ... }
 */
export function RateLimit(options: RateLimitDecoratorOptions): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_METADATA, options);
}

/**
 * Skip rate limiting for a controller or route.
 *
 * @remarks
 * With one or more **names**, metadata is stored for forward compatibility, but the guard currently treats
 * any named skip the same as a full skip (rate limiting is not applied for that handler). Per-layer skip
 * would require matching composed store labels to engine layers.
 *
 * @example
 * @SkipRateLimit()
 * @Controller('health')
 * export class HealthController { ... }
 */
export function SkipRateLimit(...names: string[]): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_SKIP_METADATA, names.length > 0 ? names : true);
}
