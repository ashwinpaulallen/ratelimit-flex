/** Shared types for rate limiting */

import type { MetricsConfig } from './metrics.js';

export type {
  HotKeyIntervalCounts,
  MetricsCollectorOptions,
  MetricsConfig,
  MetricsSnapshot,
} from './metrics.js';

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
 * One layer’s row when {@link ComposedStore} reports per-layer state (same shape as composition internals).
 *
 * @see {@link RateLimitOptionsBase.onLayerBlock}
 * @since 2.0.0
 */
export interface LayerResult {
  totalHits: number;
  remaining: number;
  resetTime: Date;
  isBlocked: boolean;
  consulted: boolean;
  error?: string;
}

/**
 * Result of calling {@link RateLimitStore.increment}.
 *
 * @description Snapshot of usage after recording (or attempting) a weighted increment for a key. When {@link RateLimitIncrementOptions.cost} is above `1`, window strategies count **units** (not only HTTP requests); token bucket `totalHits` reflects consumed capacity (`bucketSize - remaining`).
 * @see {@link RateLimitStore}
 * @since 1.0.0
 */
export interface RateLimitResult {
  /**
   * @description Usage in the current window/bucket (sliding/fixed: counted units including {@link RateLimitIncrementOptions.cost}; token bucket: derived from remaining tokens).
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
  /**
   * @description When {@link ComposedStore} produced this result: composition mode (`all`, `overflow`, etc.).
   * @since 2.0.0
   */
  mode?: string;
  /**
   * @description When {@link ComposedStore} produced this result: label of the layer that decided the outcome.
   * @since 2.0.0
   */
  decidingLayer?: string;
  /**
   * @description When {@link ComposedStore} produced this result: per-layer rows keyed by layer label.
   * @since 2.0.0
   */
  layers?: Record<string, LayerResult>;
}

/**
 * Result of {@link RateLimitEngine.consume} / {@link RateLimitEngine.consumeWithKey}.
 *
 * @description Extends {@link RateLimitResult} with block metadata; **`headers`** is always **`{}`** (middleware sets HTTP headers via **`formatRateLimitHeaders`**).
 * @see `RateLimitEngine` in `../strategies/rate-limit-engine.js`
 * @since 1.0.0
 */
export interface RateLimitConsumeResult extends RateLimitResult {
  /**
   * @description Always **`{}`**. `expressRateLimiter` / `fastifyRateLimiter` set response headers via **`formatRateLimitHeaders`**; the engine does not allocate header maps on consume.
   */
  headers: Record<string, string>;
  /**
   * @description When {@link WindowRateLimitOptions.draft} is true and the request would have been blocked.
   * @default undefined
   */
  draftWouldBlock?: boolean;
  /**
   * @description Why the request was blocked when {@link RateLimitResult.isBlocked} is true.
   * @default undefined when allowed
   */
  blockReason?: 'rate_limit' | 'blocklist' | 'penalty' | 'service_unavailable';
  /**
   * @description Index into {@link WindowRateLimitOptions.groupedWindowStores} for the **binding constraint**: the slot that caused a block, or the slot with the lowest remaining quota when no block occurred.
   * @default undefined when not using grouped windows or when not yet computed by the engine
   */
  bindingSlotIndex?: number;
}

/**
 * Optional per-call overrides for {@link RateLimitStore.increment}.
 *
 * @description **`maxRequests`** applies to sliding/fixed window only (dynamic cap when `maxRequests` is a function). **`cost`** applies to all strategies (sliding, fixed, token bucket) for weighted requests.
 * @see {@link RateLimitOptionsBase.incrementCost}
 * @since 1.1.0
 */
export interface RateLimitIncrementOptions {
  /**
   * @description Overrides the store’s configured max for this increment only (sliding/fixed window; ignored for token bucket).
   * @default undefined (use store’s configured cap)
   */
  maxRequests?: number;
  /**
   * @description How many quota units this call consumes (default `1`). Use for weighted endpoints (e.g. uploads, expensive GraphQL).
   * @default 1
   * @since 1.3.1
   */
  cost?: number;
}

/**
 * Optional per-call weight for {@link RateLimitStore.decrement}.
 *
 * @description When rolling back a weighted increment, pass the same **`cost`** as that increment. Sliding window: removes **`cost`** oldest entries (FIFO).
 * @since 1.3.1
 */
export interface RateLimitDecrementOptions {
  /**
   * @description How many units to remove (must match the increment’s `cost` when undoing that request).
   * @default 1
   */
  cost?: number;
  /**
   * @description **Sliding window only:** remove the **newest** counted units (LIFO) instead of the oldest (FIFO).
   * Used by {@link RateLimiterQueue} to undo a rejected increment probe (or a race where the queue head moved)
   * without evicting earlier legitimate hits.
   * @since 1.4.3
   */
  removeNewest?: boolean;
}

/**
 * One key’s usage snapshot from {@link RateLimitStore.getActiveKeys}.
 *
 * @description **`totalHits`** matches the store’s notion of usage for that key; **`resetTime`** is the next window/bucket boundary (same semantics as {@link RateLimitResult.resetTime}).
 * @since 1.3.2
 */
export interface RateLimitActiveKeyEntry {
  /** @description Current counted usage (window units or bucket consumption). */
  totalHits: number;
  /** @description Next reset / meaningful boundary for this key. */
  resetTime: Date;
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
   * @description Record one weighted increment for `key` and return quota state.
   * @param key - Stable client identifier (from {@link RateLimitOptionsBase.keyGenerator}).
   * @param options - Optional **`maxRequests`** (sliding/fixed only) and **`cost`** (all strategies; default `1`).
   * @returns Promise resolving to {@link RateLimitResult}.
   */
  increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult>;

  /**
   * @description Undo quota when middleware “skip failed/successful” options apply after the response, or when draft/grouped rollback runs.
   * Sliding-window stores remove the **oldest** entries first (**FIFO**) by default; set **`removeNewest`** to undo the **newest** units (LIFO) for probe rollbacks (see {@link RateLimitDecrementOptions.removeNewest}).
   * **`cost`** times when the prior increment used a {@link RateLimitIncrementOptions.cost} above `1`.
   * @param key - Same key passed to {@link RateLimitStore.increment}.
   * @param options - Match the prior increment’s **`cost`** (default `1`). See {@link RateLimitDecrementOptions}.
   * @returns Promise that settles when decrement is complete.
   */
  decrement(key: string, options?: RateLimitDecrementOptions): Promise<void>;

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

  /**
   * @description Optional: snapshot all keys with non-expired quota state (for syncing in-memory counters elsewhere).
   * @returns Map of key → `{ totalHits, resetTime }` for active entries only.
   * @since 1.3.2
   */
  getActiveKeys?(): Map<string, RateLimitActiveKeyEntry>;

  /**
   * @description Optional: clear all keys and counters in one shot (e.g. before rehydrating from Redis). Implementations without shared memory may omit this.
   * @since 1.3.2
   */
  resetAll?(): void;
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
 * String literal union for {@link RateLimitOptionsBase.standardHeaders} (excluding booleans **`true`** / **`false`**, which are typed separately on the option).
 *
 * @description Same string values as **`HeaderFormat`** used by {@link formatRateLimitHeaders}. Use with `standardHeaders: 'draft-6'` etc., or rely on {@link RateLimitOptionsBase.headers} / defaults for legacy `X-RateLimit-*` behavior.
 * @since 1.4.0
 */
export type StandardHeadersDraft = 'legacy' | 'draft-6' | 'draft-7' | 'draft-8';

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
   * @remarks
   * Behind reverse proxies, **`req.ip`** / **`socket.remoteAddress`** may identify the proxy unless the app is configured to trust forwarded client addresses (e.g. Express **`trust proxy`**, Fastify **`trustProxy`**). Otherwise limits can apply to the wrong identity. Prefer a custom **`keyGenerator`** (API key, user id) when IP is not reliable.
   */
  keyGenerator?: (req: unknown) => string;

  /**
   * @description Called after a **rate limit** block (not blocklist/penalty). Useful for logging or metrics.
   * @default undefined
   */
  onLimitReached?: (req: unknown, result: RateLimitResult) => void | Promise<void>;

  /**
   * @description Called when a specific layer in a {@link ComposedStore} reports a block (after {@link RateLimitStore.increment}, before {@link RateLimitOptionsBase.onLimitReached}). Fires once per blocked layer with `consulted` and no `error`. Only applies when the store returns {@link RateLimitResult.layers}.
   * @default undefined
   * @since 2.0.0
   */
  onLayerBlock?: (req: unknown, layerLabel: string, layerResult: LayerResult) => void | Promise<void>;

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
   * @description When true, attach `X-RateLimit-*` and `Retry-After` headers on allowed responses (legacy behavior).
   * @default true
   * @see {@link RateLimitOptionsBase.standardHeaders} — when set, takes precedence over this flag for choosing the header profile.
   */
  headers?: boolean;

  /**
   * @description Controls which rate-limit response headers Express/Fastify attach (via {@link formatRateLimitHeaders}). Must be **`true`**, **`false`**, or one of {@link StandardHeadersDraft}; invalid strings throw at options merge / engine creation.
   *
   * **Profiles (example values for limit `100`, window 60s, remaining `42`, seconds-until-reset `30`):**
   *
   * | Value | Typical response headers |
   * | --- | --- |
   * | **`'legacy'`** or **`true`** | `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining: 42`, `X-RateLimit-Reset: <epoch seconds>`; plus `Retry-After: <seconds>` when blocked |
   * | **`'draft-6'`** | `RateLimit-Limit: 100`, `RateLimit-Remaining: 42`, `RateLimit-Reset: 30` (seconds until reset), `RateLimit-Policy: 100;w=60`; `Retry-After` when blocked |
   * | **`'draft-7'`** | `RateLimit: limit=100, remaining=42, reset=30`, `RateLimit-Policy: 100;w=60`; `Retry-After` when blocked |
   * | **`'draft-8'`** | `RateLimit-Policy: "100-per-60";q=100;w=60`, `RateLimit: "100-per-60";r=42;t=30` (or custom {@link RateLimitOptionsBase.identifier}); `Retry-After` when blocked |
   * | **`false`** | No rate-limit headers |
   *
   * **Precedence:** when both {@link RateLimitOptionsBase.headers} and `standardHeaders` are set, `standardHeaders` wins. When both are omitted, middleware defaults to legacy `X-RateLimit-*` headers (same as `headers: true` / `standardHeaders: 'legacy'`).
   * @default undefined
   * @since 1.4.0
   */
  standardHeaders?: StandardHeadersDraft | boolean;

  /**
   * @description Policy name for draft-8 (and policy strings where applicable). Must be a **string** if set. Non-ASCII characters are replaced when emitting RFC 8941–safe names (a **console warning** is logged once per process when non-ASCII is detected). Defaults to `"{limit}-per-{windowSeconds}"` from the resolved limit and window (e.g. `"100-per-60"`). Ignored for legacy and draft-6.
   * @default undefined
   * @since 1.4.0
   */
  identifier?: string;

  /**
   * @description When **`true`** and `standardHeaders` is a **draft** profile (`'draft-6'` \| `'draft-7'` \| `'draft-8'`), also emit legacy `X-RateLimit-*` (and `Retry-After` when blocked) alongside the draft headers. When `standardHeaders` is **`'legacy'`** or **`true`**, legacy headers are always the primary set; this flag mainly affects draft profiles. Defaults are resolved in {@link resolveHeaderConfig}.
   * @default undefined
   * @since 1.4.0
   */
  legacyHeaders?: boolean;

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

  /**
   * @description Observability: `true` enables defaults; object configures intervals and callbacks.
   * @default undefined (no metrics)
   * @since 1.3.0
   */
  metrics?: MetricsConfig | boolean;

  /**
   * @description Per-request quota weight for {@link RateLimitStore.increment} (equivalent to passing `{ cost }` on each increment).
   * @default undefined (cost `1`)
   * @since 1.3.1
   */
  incrementCost?: number | ((req: unknown) => number);
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
   * @description Multiple independent windows for the same route; blocks if any limit is exceeded. Merged options build a {@link ComposedStore} via {@link compose.windows} (mutually exclusive with a custom `store`). Top-level `windowMs` / `maxRequests` are set to the shortest window and minimum cap for header defaults.
   * @default undefined
   * @since 1.1.0
   */
  limits?: readonly WindowLimitSpec[];

  /**
   * @description Advanced: supply one store per window (e.g. shared {@link RedisStore} per slot). Mutually exclusive with {@link WindowRateLimitOptions.limits}; do not set together with `limits`.
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
