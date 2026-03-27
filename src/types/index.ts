/** Shared types for rate limiting */

/**
 * Built-in rate limiting algorithms.
 */
export enum RateLimitStrategy {
  SLIDING_WINDOW = 'SLIDING_WINDOW',
  TOKEN_BUCKET = 'TOKEN_BUCKET',
  FIXED_WINDOW = 'FIXED_WINDOW',
}

/**
 * Result of incrementing a counter in the backing store.
 */
export interface RateLimitResult {
  totalHits: number;
  remaining: number;
  resetTime: Date;
  isBlocked: boolean;
}

/**
 * Pluggable persistence for rate limit state.
 */
export interface RateLimitStore {
  increment(key: string): Promise<RateLimitResult>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Per-request rate limit snapshot (e.g. for headers or `req` augmentation).
 */
export interface RateLimitInfo {
  limit: number;
  current: number;
  remaining: number;
  resetTime: Date;
}

/**
 * Options shared by all strategies.
 */
export interface RateLimitOptionsBase {
  /**
   * Function to extract a stable identifier for the client (e.g. IP).
   * Default in implementations is typically `req.ip` when present.
   */
  keyGenerator?: (req: unknown) => string;

  /** Invoked when the limit is exceeded. */
  onLimitReached?: (req: unknown, result: RateLimitResult) => void | Promise<void>;

  /** When true, failed responses do not count toward the limit. @default false */
  skipFailedRequests?: boolean;

  /** When true, successful responses do not count toward the limit. @default false */
  skipSuccessfulRequests?: boolean;

  /** When true, send `X-RateLimit-*` headers. @default true */
  headers?: boolean;

  /** HTTP status when blocked. @default 429 */
  statusCode?: number;

  /** Body or payload when blocked. @default "Too many requests" */
  message?: string | object;

  /** When true, rate limiting is skipped for this request. */
  skip?: (req: unknown) => boolean;

  /** Backing store for counters / bucket state. */
  store: RateLimitStore;
}

/**
 * Options for sliding-window and fixed-window strategies.
 * @default strategy SLIDING_WINDOW, windowMs 60000, maxRequests 100
 */
export interface WindowRateLimitOptions extends RateLimitOptionsBase {
  strategy?: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;

  /** Time window in milliseconds. @default 60000 */
  windowMs?: number;

  /** Max requests allowed per window. @default 100 */
  maxRequests?: number;
}

/**
 * Options when using {@link RateLimitStrategy.TOKEN_BUCKET}.
 */
export interface TokenBucketRateLimitOptions extends RateLimitOptionsBase {
  strategy: RateLimitStrategy.TOKEN_BUCKET;

  /** Tokens added per {@link TokenBucketRateLimitOptions.interval}. */
  tokensPerInterval: number;

  /** Interval length in milliseconds. */
  interval: number;

  /** Maximum tokens (burst capacity). */
  bucketSize: number;
}

/**
 * Configuration for the rate limiter.
 *
 * Use {@link WindowRateLimitOptions} for sliding/fixed window, or
 * {@link TokenBucketRateLimitOptions} for token bucket (extra fields required).
 */
export type RateLimitOptions = WindowRateLimitOptions | TokenBucketRateLimitOptions;
