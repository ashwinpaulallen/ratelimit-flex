/** Shared types for rate limiting */

/**
 * Built-in rate limiting algorithms.
 *
 * @description Selects how quota is counted and enforced.
 * @see {@link WindowRateLimitOptions} — sliding and fixed window options
 * @see {@link TokenBucketRateLimitOptions} — token bucket options
 * @since 1.0.0
 */
export enum RateLimitStrategy {
  /** @description Moving window of timestamps; smooth boundary behavior. */
  SLIDING_WINDOW = 'SLIDING_WINDOW',
  /** @description Refill tokens on an interval; supports bursts up to {@link TokenBucketRateLimitOptions.bucketSize}. */
  TOKEN_BUCKET = 'TOKEN_BUCKET',
  /** @description Single counter per fixed time slice; lowest memory, coarser boundaries. */
  FIXED_WINDOW = 'FIXED_WINDOW',
}

/**
 * Result of calling {@link RateLimitStore.increment}.
 *
 * @description Snapshot of usage after recording (or attempting) one hit for a key.
 * @see {@link RateLimitStore}
 * @since 1.0.0
 */
export interface RateLimitResult {
  /**
   * @description Number of hits counted in the current window/bucket context (semantics depend on strategy).
   */
  totalHits: number;
  /**
   * @description Remaining quota before the next block; `0` when {@link RateLimitResult.isBlocked} is true.
   */
  remaining: number;
  /**
   * @description When the window resets or the next meaningful boundary for headers / `Retry-After`.
   */
  resetTime: Date;
  /**
   * @description Whether this request should be treated as over the limit.
   */
  isBlocked: boolean;
  /**
   * @description Set when {@link RedisStore} cannot complete the operation in `fail-closed` mode.
   * @default undefined
   * @see {@link RedisStore}
   */
  storeUnavailable?: boolean;
}

/**
 * Optional per-call overrides for {@link RateLimitStore.increment} (window strategies only).
 *
 * @description Lets {@link RateLimitEngine} pass a dynamic cap when `maxRequests` is a function.
 * @since 1.1.0
 */
export interface RateLimitIncrementOptions {
  /**
   * @description Overrides the store’s configured max for this increment only (sliding/fixed window).
   * @default undefined (use store’s configured cap)
   */
  maxRequests?: number;
}

/**
 * Pluggable persistence for rate limit state (counters, bucket fields, etc.).
 *
 * @description Implement this to back the limiter with custom storage (e.g. another database).
 * @see {@link MemoryStore} — in-process implementation
 * @see {@link RedisStore} — Redis + Lua implementation
 * @since 1.0.0
 */
export interface RateLimitStore {
  /**
   * @description Record one request for `key` and return quota state.
   * @param key - Stable client identifier (from {@link RateLimitOptionsBase.keyGenerator}).
   * @param options - Optional per-call max override for window strategies.
   * @returns Promise resolving to {@link RateLimitResult}.
   */
  increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult>;

  /**
   * @description Undo one hit when middleware “skip failed/successful” options apply after the response.
   * @param key - Same key passed to {@link RateLimitStore.increment}.
   * @returns Promise that settles when decrement is complete.
   */
  decrement(key: string): Promise<void>;

  /**
   * @description Clear stored state for `key` (admin / logout flows).
   * @param key - Client key to reset.
   * @returns Promise that settles when reset is complete.
   */
  reset(key: string): Promise<void>;

  /**
   * @description Release timers, connections, or other resources held by the store.
   * @returns Promise that settles when shutdown is complete.
   */
  shutdown(): Promise<void>;
}

/**
 * Per-request rate limit snapshot (e.g. for `X-RateLimit-*` headers or `req.rateLimit`).
 *
 * @description Populated by framework middleware after a successful consume (not blocked). Express sets `req.rateLimit`; Fastify sets `request.rateLimit`.
 * @since 1.0.0
 */
export interface RateLimitInfo {
  /**
   * @description Configured limit for display (may reflect dynamic `maxRequests`).
   */
  limit: number;
  /**
   * @description Current usage (same notion as {@link RateLimitResult.totalHits} for the response).
   */
  current: number;
  /**
   * @description Remaining quota.
   */
  remaining: number;
  /**
   * @description Reset time for the limit window/bucket.
   */
  resetTime: Date;
}

/**
 * Options shared by all strategies (plus a required {@link RateLimitOptionsBase.store} on concrete configs).
 *
 * @description Base shape extended by {@link WindowRateLimitOptions} and {@link TokenBucketRateLimitOptions}.
 * @since 1.0.0
 */
export interface RateLimitOptionsBase {
  /**
   * @description Builds a stable storage key per request (IP, API key, user id, etc.).
   * @default Framework fallback uses `req.ip`, then `socket.remoteAddress`, else `"unknown"` ({@link defaultKeyGenerator}).
   */
  keyGenerator?: (req: unknown) => string;

  /**
   * @description Called after a **rate limit** block (not blocklist/penalty). Useful for logging or metrics.
   * @default undefined
   */
  onLimitReached?: (req: unknown, result: RateLimitResult) => void | Promise<void>;

  /**
   * @description When true, responses with status `>= 400` trigger a {@link RateLimitStore.decrement} after send.
   * @default false
   */
  skipFailedRequests?: boolean;

  /**
   * @description When true, responses with status `< 400` trigger a {@link RateLimitStore.decrement} after send.
   * @default false
   */
  skipSuccessfulRequests?: boolean;

  /**
   * @description When true, attach `X-RateLimit-*` and `Retry-After` headers on allowed responses.
   * @default true
   */
  headers?: boolean;

  /**
   * @description HTTP status when blocked by **rate limit** (not blocklist).
   * @default 429
   */
  statusCode?: number;

  /**
   * @description Body payload when rate-limited; wrapped as `{ error: message }` by middleware.
   * @default `"Too many requests"`
   */
  message?: string | object;

  /**
   * @description When true, skip rate limiting entirely for that request.
   * @default undefined (never skip)
   */
  skip?: (req: unknown) => boolean;

  /**
   * @description Keys (from {@link RateLimitOptionsBase.keyGenerator}) that never consume quota.
   * @default undefined
   */
  allowlist?: readonly string[];

  /**
   * @description Keys rejected before quota is consumed (policy block).
   * @default undefined
   */
  blocklist?: readonly string[];

  /**
   * @description HTTP status for {@link RateLimitOptionsBase.blocklist} hits.
   * @default 403
   */
  blocklistStatusCode?: number;

  /**
   * @description Response body for blocklist hits; wrapped as `{ error: blocklistMessage }`.
   * @default `"Forbidden"`
   */
  blocklistMessage?: string | object;

  /**
   * @description Temporary ban after repeated real rate-limit violations (engine-local, not in store).
   * @default undefined
   * @since 1.1.0
   */
  penaltyBox?: PenaltyBoxOptions;

  /**
   * @description If true, would-be blocks are rolled back and logged via {@link RateLimitOptionsBase.onDraftViolation}.
   * @default false
   * @since 1.1.0
   */
  draft?: boolean;

  /**
   * @description Called in {@link RateLimitOptionsBase.draft} mode when a request would have been blocked.
   * @default undefined
   * @since 1.1.0
   */
  onDraftViolation?: (req: unknown, result: RateLimitResult) => void | Promise<void>;

  /**
   * @description Backing store for counters / bucket state.
   * @see {@link MemoryStore}
   * @see {@link RedisStore}
   */
  store: RateLimitStore;
}

/**
 * Temporary ban after repeated rate-limit violations (in-memory on {@link RateLimitEngine}).
 *
 * @description Not synchronized across processes; use with awareness in multi-instance deployments.
 * @see {@link RateLimitOptionsBase.penaltyBox}
 * @since 1.1.0
 */
export interface PenaltyBoxOptions {
  /**
   * @description How many **real** rate-limit blocks (not draft) trigger a penalty.
   */
  violationsThreshold: number;

  /**
   * @description Sliding window in which violations are counted toward the threshold.
   * @default 3600000 (1 hour)
   */
  violationWindowMs?: number;

  /**
   * @description How long the client stays blocked after the threshold is reached.
   */
  penaltyDurationMs: number;

  /**
   * @description Optional callback when a key enters the penalty state.
   * @default undefined
   */
  onPenalty?: (req: unknown) => void | Promise<void>;
}

/**
 * One independent window in a multi-limit configuration.
 *
 * @description Used with {@link WindowRateLimitOptions.limits}. The request is blocked if **any** window is exceeded.
 * @since 1.1.0
 */
export interface WindowLimitSpec {
  /**
   * @description Length of this window in milliseconds.
   */
  windowMs: number;
  /**
   * @description Max requests allowed in this window (same role as `maxRequests` in single-window mode).
   */
  max: number;
}

/**
 * Options for sliding-window and fixed-window strategies.
 *
 * @description Default strategy is {@link RateLimitStrategy.SLIDING_WINDOW} when merged by middleware helpers.
 * @see {@link TokenBucketRateLimitOptions} — token bucket variant
 * @since 1.0.0
 */
export interface WindowRateLimitOptions extends RateLimitOptionsBase {
  /**
   * @description Window vs fixed counter behavior.
   * @default {@link RateLimitStrategy.SLIDING_WINDOW}
   */
  strategy?: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;

  /**
   * @description Multiple independent windows for the same route; blocks if any limit is exceeded. When set, single `windowMs`/`maxRequests` are ignored for the default store setup.
   * @default undefined
   * @since 1.1.0
   */
  limits?: readonly WindowLimitSpec[];

  /**
   * @description Populated from {@link WindowRateLimitOptions.limits} by middleware merge — do not set manually.
   * @default undefined
   * @since 1.1.0
   */
  groupedWindowStores?: ReadonlyArray<{
    /** @description Window length for this slot. */
    windowMs: number;
    /** @description Max requests for this slot. */
    maxRequests: number;
    /** @description Dedicated store for this window. */
    store: RateLimitStore;
  }>;

  /**
   * @description Time window in milliseconds (ignored when {@link WindowRateLimitOptions.limits} is set).
   * @default 60000
   */
  windowMs?: number;

  /**
   * @description Max requests per window, or a function for per-request caps (ignored when `limits` is set for the default store).
   * @default 100
   */
  maxRequests?: number | ((req: unknown) => number);
}

/**
 * Options when using {@link RateLimitStrategy.TOKEN_BUCKET}.
 *
 * @description Requires {@link TokenBucketRateLimitOptions.tokensPerInterval}, {@link TokenBucketRateLimitOptions.interval}, and {@link TokenBucketRateLimitOptions.bucketSize}.
 * @see {@link WindowRateLimitOptions}
 * @since 1.0.0
 */
export interface TokenBucketRateLimitOptions extends RateLimitOptionsBase {
  /** @description Must be {@link RateLimitStrategy.TOKEN_BUCKET}. */
  strategy: RateLimitStrategy.TOKEN_BUCKET;

  /**
   * @description Tokens added each {@link TokenBucketRateLimitOptions.interval}.
   */
  tokensPerInterval: number;

  /**
   * @description Length of one refill interval in milliseconds.
   */
  interval: number;

  /**
   * @description Maximum tokens (burst capacity).
   */
  bucketSize: number;
}

/**
 * Full rate limiter configuration (window-based or token bucket).
 *
 * @description Discriminated by `strategy`: token bucket requires extra fields on {@link TokenBucketRateLimitOptions}.
 * @see {@link WindowRateLimitOptions}
 * @see {@link TokenBucketRateLimitOptions}
 * @since 1.0.0
 */
export type RateLimitOptions = WindowRateLimitOptions | TokenBucketRateLimitOptions;
