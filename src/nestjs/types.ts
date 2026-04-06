import type { ExecutionContext } from '@nestjs/common';
import type { RateLimitOptions, RateLimitStrategy } from '../types/index.js';

/**
 * Options for RateLimitModule.forRoot().
 * Extends RateLimitOptions with NestJS-specific fields.
 */
export type NestRateLimitModuleOptions = Partial<RateLimitOptions> & {
  /**
   * When `true` (default): registers {@link RateLimitGuard} via `APP_GUARD` and registers this module as a
   * Nest **global module** so `RATE_LIMIT_*` tokens are available in any module without importing `RateLimitModule` again.
   * When `false`: no automatic guard (use `@UseGuards(RateLimitGuard)` or register the guard yourself) and the module is
   * **not** global — import `RateLimitModule` wherever you need the tokens.
   */
  globalGuard?: boolean;

  /**
   * @deprecated Use {@link NestRateLimitModuleOptions.globalGuard} instead (same behavior).
   */
  global?: boolean;

  /**
   * Custom key generator that receives the NestJS ExecutionContext.
   * More powerful than the base keyGenerator because you have access to
   * the handler, class, and request type (HTTP, WS, RPC, GQL).
   */
  keyGenerator?: (context: ExecutionContext) => string | Promise<string>;

  /**
   * Custom function to extract request and response from ExecutionContext.
   * Override for GraphQL, WebSocket, or RPC contexts.
   * Default: extracts from HTTP context.
   */
  getRequestResponse?: (context: ExecutionContext) => {
    req: unknown;
    res: unknown;
  };

  /**
   * Error factory for customizing the exception thrown when rate limited.
   * Default: throws HttpException(429, { statusCode: 429, message: 'Too Many Requests' })
   */
  errorFactory?: (
    context: ExecutionContext,
    result: { totalHits: number; remaining: number; resetTime: Date }
  ) => Error;

  /**
   * Whether to skip rate limiting in certain conditions.
   * Receives ExecutionContext for full introspection.
   */
  skip?: (context: ExecutionContext) => boolean | Promise<boolean>;
};

/**
 * Per-route override via @RateLimit() decorator.
 */
export interface RateLimitDecoratorOptions {
  /** Max requests for this route. Overrides global maxRequests. */
  maxRequests?: number;
  /** Window duration for this route. Overrides global windowMs. */
  windowMs?: number;
  /**
   * Strategy override for this route.
   * @remarks If this differs from the module’s strategy, {@link RateLimitGuard} ignores it (shared store/engine); a dev warning is emitted when `NODE_ENV !== 'production'`.
   */
  strategy?: RateLimitStrategy;
  /** Custom key generator for this route */
  keyGenerator?: (context: ExecutionContext) => string | Promise<string>;
  /** Cost for this route (weighted limiting) */
  cost?: number;
}

/** Injection tokens for DI */
export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export const RATE_LIMIT_KEY_MANAGER = Symbol('RATE_LIMIT_KEY_MANAGER');
export const RATE_LIMIT_SHIELD = Symbol('RATE_LIMIT_SHIELD');
/** Injected `MetricsManager` from `RateLimitModule` — snapshots, Prometheus handlers, `shutdown` on teardown. */
export const RATE_LIMIT_METRICS = Symbol('RATE_LIMIT_METRICS');

/** Metadata keys for decorators */
export const RATE_LIMIT_METADATA = 'ratelimit-flex:rate-limit';
export const RATE_LIMIT_SKIP_METADATA = 'ratelimit-flex:skip';
