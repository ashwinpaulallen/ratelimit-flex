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
 * Optional per-call overrides for {@link RateLimitStore.increment} (window strategies).
 */
export interface RateLimitIncrementOptions {
  /** Overrides the store's configured max for this increment only. */
  maxRequests?: number;
}

/**
 * Pluggable persistence for rate limit state.
 */
export interface RateLimitStore {
  increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult>;
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

  /**
   * IPs or keys (from {@link keyGenerator}) that are never rate limited.
   * Checked after {@link skip} and before {@link blocklist}.
   */
  allowlist?: readonly string[];

  /**
   * IPs or keys that are always rejected (before consuming quota).
   * @default HTTP 403 with {@link blocklistMessage}
   */
  blocklist?: readonly string[];

  /** HTTP status for {@link blocklist} hits. @default 403 */
  blocklistStatusCode?: number;

  /** Body when blocked by {@link blocklist}. @default "Forbidden" */
  blocklistMessage?: string | object;

  /**
   * After this many real rate-limit blocks (not draft), the client is banned for {@link PenaltyBoxOptions.penaltyDurationMs}.
   * Violations are counted within {@link PenaltyBoxOptions.violationWindowMs}.
   */
  penaltyBox?: PenaltyBoxOptions;

  /**
   * When true, requests that would be rate limited are still allowed; use {@link onDraftViolation} to log.
   * The increment is rolled back so production traffic is not penalized while you tune limits.
   */
  draft?: boolean;

  /** Invoked when {@link draft} is true and a request would have been blocked. */
  onDraftViolation?: (req: unknown, result: RateLimitResult) => void | Promise<void>;

  /** Backing store for counters / bucket state. */
  store: RateLimitStore;
}

/**
 * Temporary ban after repeated limit violations.
 */
export interface PenaltyBoxOptions {
  /** Number of limit violations that trigger a penalty. */
  violationsThreshold: number;

  /** Only violations within this sliding window count toward the threshold. @default 3600000 (1h) */
  violationWindowMs?: number;

  /** How long the client stays blocked after the threshold is reached. */
  penaltyDurationMs: number;

  /** Called when a client enters the penalty state. */
  onPenalty?: (req: unknown) => void | Promise<void>;
}

/**
 * One window in a multi-limit configuration ({@link WindowRateLimitOptions.limits}).
 * A request is blocked if **any** window is exceeded.
 */
export interface WindowLimitSpec {
  windowMs: number;
  /** Max requests allowed in this window (alias of `maxRequests` in single-window mode). */
  max: number;
}

/**
 * Options for sliding-window and fixed-window strategies.
 * @default strategy SLIDING_WINDOW, windowMs 60000, maxRequests 100
 */
export interface WindowRateLimitOptions extends RateLimitOptionsBase {
  strategy?: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;

  /**
   * Multiple independent windows for the same route. If set, {@link windowMs} / {@link maxRequests}
   * are ignored for the primary store; one backing store per entry is used (see {@link mergeRateLimiterOptions}).
   */
  limits?: readonly WindowLimitSpec[];

  /**
   * Filled from {@link limits} by {@link mergeRateLimiterOptions}. Do not set manually.
   */
  groupedWindowStores?: ReadonlyArray<{
    windowMs: number;
    maxRequests: number;
    store: RateLimitStore;
  }>;

  /** Time window in milliseconds. @default 60000 */
  windowMs?: number;

  /**
   * Max requests allowed per window. @default 100
   * May be a function for per-request limits (e.g. premium vs free).
   */
  maxRequests?: number | ((req: unknown) => number);
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
