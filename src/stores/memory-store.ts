import type {
  RateLimitActiveKeyEntry,
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeIncrementCost, sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';

/**
 * Constructor options for window-based strategies (sliding or fixed).
 *
 * @description Use with {@link RateLimitStrategy.SLIDING_WINDOW} or {@link RateLimitStrategy.FIXED_WINDOW}.
 * @see {@link MemoryStoreTokenBucketOptions}
 * @see {@link RedisStore} — distributed alternative
 * @since 1.0.0
 */
export type MemoryStoreWindowOptions = {
  /**
   * @description Window vs fixed counter.
   */
  strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
  /**
   * @description Length of the rate-limit window in milliseconds (sanitized by the constructor).
   */
  windowMs: number;
  /**
   * @description Maximum requests allowed per window (sanitized by the constructor).
   */
  maxRequests: number;
};

/**
 * Constructor options for the token-bucket strategy.
 *
 * @description Use with {@link RateLimitStrategy.TOKEN_BUCKET}.
 * @see {@link MemoryStoreWindowOptions}
 * @since 1.0.0
 */
export type MemoryStoreTokenBucketOptions = {
  /** @description Must be {@link RateLimitStrategy.TOKEN_BUCKET}. */
  strategy: RateLimitStrategy.TOKEN_BUCKET;
  /**
   * @description Tokens added on each refill interval.
   */
  tokensPerInterval: number;
  /**
   * @description Refill interval length in milliseconds (also drives cleanup cadence).
   */
  interval: number;
  /**
   * @description Maximum tokens (burst capacity).
   */
  bucketSize: number;
};

/**
 * Discriminated union of {@link MemoryStore} constructor options.
 *
 * @since 1.0.0
 */
export type MemoryStoreOptions = MemoryStoreWindowOptions | MemoryStoreTokenBucketOptions;

/**
 * Value shape for {@link MemoryStore.getActiveKeys} entries (alias of {@link RateLimitActiveKeyEntry}).
 *
 * @since 1.3.2
 */
export type { RateLimitActiveKeyEntry };

type FixedEntry = { count: number; resetTime: number };
type BucketEntry = { tokens: number; lastRefill: number };

/**
 * In-process {@link RateLimitStore} (not shared across Node processes).
 *
 * @description
 * - **Sliding window**: request timestamps per key; counts **units** inside `windowMs` (each increment adds {@link RateLimitIncrementOptions.cost} defaulting to `1`).
 * - **Fixed window**: counter + window end; resets when the slice expires.
 * - **Token bucket**: refills tokens on a schedule; each allowed increment consumes **`cost`** tokens (default `1`).
 *
 * A background timer periodically purges stale keys / trims timestamps (`unref` so it does not keep the process alive alone).
 *
 * @see {@link RedisStore} — use when multiple instances must share counters
 * @since 1.0.0
 */
export class MemoryStore implements RateLimitStore {
  private readonly strategy: RateLimitStrategy;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  private readonly tokensPerInterval: number;

  private readonly refillIntervalMs: number;

  private readonly bucketSize: number;

  /** How often the background purge runs (ms). */
  private readonly cleanupEveryMs: number;

  /** Request timestamps (sliding window only). */
  private readonly sliding = new Map<string, number[]>();

  /** Counter + window end (fixed window only). */
  private readonly fixed = new Map<string, FixedEntry>();

  /** Token bucket state (token bucket only). */
  private readonly buckets = new Map<string, BucketEntry>();

  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @description Creates a store for one strategy; dispatches to sliding, fixed, or token-bucket internals.
   * @param options - Window or token-bucket configuration (see {@link MemoryStoreOptions}).
   * @example
   * ```ts
   * const store = new MemoryStore({
   *   strategy: RateLimitStrategy.SLIDING_WINDOW,
   *   windowMs: 60_000,
   *   maxRequests: 100,
   * });
   * ```
   * @see {@link MemoryStore.shutdown} — stop the background timer and clear maps
   * @since 1.0.0
   */
  constructor(options: MemoryStoreOptions) {
    this.strategy = options.strategy;

    if (options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      this.windowMs = 0;
      this.maxRequests = 0;
      this.tokensPerInterval = options.tokensPerInterval;
      this.refillIntervalMs = options.interval;
      this.bucketSize = options.bucketSize;
      // Align cleanup with refill cadence; avoids a separate windowMs for bucket mode.
      this.cleanupEveryMs = Math.max(1, options.interval);
    } else {
      this.windowMs = sanitizeWindowMs(options.windowMs, 60_000);
      this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
      this.tokensPerInterval = 0;
      this.refillIntervalMs = 0;
      this.bucketSize = 0;
      this.cleanupEveryMs = Math.max(1, options.windowMs);
    }

    this.cleanupTimer = setInterval(() => {
      this.purgeExpired();
    }, this.cleanupEveryMs);

    // Do not keep the process alive solely because of this timer (Node.js).
    if (
      typeof this.cleanupTimer === 'object' &&
      this.cleanupTimer !== null &&
      'unref' in this.cleanupTimer
    ) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Configured window length for sliding/fixed strategies (used by composition diagnostics).
   * Token bucket returns `undefined`.
   *
   * @since 2.0.0
   */
  getWindowLengthMs(): number | undefined {
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return undefined;
    }
    return this.windowMs;
  }

  /**
   * @inheritdoc
   * @param key - Client identifier.
   * @param options - Optional **`maxRequests`** (sliding/fixed) and **`cost`** (all strategies; default `1`).
   * @returns Synchronous promise with {@link RateLimitResult}.
   * @throws If strategy is not handled (should be unreachable).
   */
  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    const cost = sanitizeIncrementCost(options?.cost, 1);
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        return Promise.resolve(this.incrementSliding(key, options?.maxRequests, cost));
      case RateLimitStrategy.FIXED_WINDOW:
        return Promise.resolve(this.incrementFixed(key, options?.maxRequests, cost));
      case RateLimitStrategy.TOKEN_BUCKET:
        return Promise.resolve(this.incrementTokenBucket(key, cost));
      default: {
        const exhaustive: never = this.strategy;
        return Promise.reject(new Error(`Unsupported strategy: ${String(exhaustive)}`));
      }
    }
  }

  /**
   * @inheritdoc
   * @param key - Same key used for {@link MemoryStore.increment}.
   * @param options - Optional **`cost`** to match the prior increment (default `1`).
   * @throws If strategy is not handled (should be unreachable).
   */
  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    const cost = sanitizeIncrementCost(options?.cost, 1);
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        if (options?.removeNewest === true) {
          this.decrementSlidingFromEnd(key, cost);
        } else {
          this.decrementSliding(key, cost);
        }
        break;
      case RateLimitStrategy.FIXED_WINDOW:
        this.decrementFixed(key, cost);
        break;
      case RateLimitStrategy.TOKEN_BUCKET:
        this.decrementTokenBucket(key, cost);
        break;
      default: {
        const exhaustive: never = this.strategy;
        throw new Error(`Unsupported strategy: ${String(exhaustive)}`);
      }
    }
    return Promise.resolve();
  }

  /**
   * @inheritdoc
   * @param key - Key to clear from all internal maps.
   */
  async reset(key: string): Promise<void> {
    this.sliding.delete(key);
    this.fixed.delete(key);
    this.buckets.delete(key);
    return Promise.resolve();
  }

  /**
   * @inheritdoc
   * @description Clears the cleanup timer and empties all maps.
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.sliding.clear();
    this.fixed.clear();
    this.buckets.clear();
    return Promise.resolve();
  }

  /**
   * @description Read-only snapshot: does **not** mutate internal maps. **Sliding window** re-applies the current cutoff (`now - windowMs`) before counting, so stale timestamps are excluded. **Token bucket** uses {@link MemoryStore.refillBucketStateForNow} and {@link MemoryStore.isBucketIdleFullPurgeable} — same logic as increment and purge. **Fixed window** omits expired slices. Returns all keys with **non-expired** quota state.
   * @returns Map of key → `{ totalHits, resetTime }` consistent with {@link RateLimitResult} semantics for each strategy.
   * @since 1.3.2
   */
  getActiveKeys(): Map<string, RateLimitActiveKeyEntry> {
    const now = Date.now();
    const out = new Map<string, RateLimitActiveKeyEntry>();

    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW: {
        const cutoff = now - this.windowMs;
        for (const [k, ts] of this.sliding.entries()) {
          const trimmed = ts.filter((t) => t > cutoff);
          if (trimmed.length === 0) {
            continue;
          }
          const oldest = trimmed[0]!;
          out.set(k, {
            totalHits: trimmed.length,
            resetTime: new Date(oldest + this.windowMs),
          });
        }
        break;
      }
      case RateLimitStrategy.FIXED_WINDOW: {
        for (const [k, v] of this.fixed.entries()) {
          if (now >= v.resetTime) {
            continue;
          }
          out.set(k, {
            totalHits: v.count,
            resetTime: new Date(v.resetTime),
          });
        }
        break;
      }
      case RateLimitStrategy.TOKEN_BUCKET: {
        for (const [k, v] of this.buckets.entries()) {
          if (this.isBucketIdleFullPurgeable(v, now)) {
            continue;
          }
          const { tokens, lastRefill } = this.refillBucketStateForNow(v, now);
          const totalHits = this.bucketSize - tokens;
          out.set(k, {
            totalHits,
            resetTime: new Date(lastRefill + this.refillIntervalMs),
          });
        }
        break;
      }
      default: {
        const exhaustive: never = this.strategy;
        throw new Error(`Unsupported strategy: ${String(exhaustive)}`);
      }
    }

    return out;
  }

  /**
   * @description Clears sliding, fixed, and bucket maps in one shot. Intended after a successful external sync (e.g. Redis counter replay); leaves the background cleanup **interval** running — only {@link MemoryStore.shutdown} stops that timer.
   * @since 1.3.2
   */
  resetAll(): void {
    this.sliding.clear();
    this.fixed.clear();
    this.buckets.clear();
  }

  // --- Sliding window -----------------------------------------------------

  private incrementSliding(key: string, maxOverride?: number, cost = 1): RateLimitResult {
    const cap = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const prev = this.sliding.get(key) ?? [];
    const trimmed = prev.filter((ts) => ts > cutoff);
    for (let i = 0; i < cost; i++) {
      trimmed.push(now);
    }
    this.sliding.set(key, trimmed);

    const totalHits = trimmed.length;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);

    const oldest = trimmed[0];
    const resetTime = new Date(oldest !== undefined ? oldest + this.windowMs : now + this.windowMs);

    return { totalHits, remaining, resetTime, isBlocked };
  }

  /**
   * Removes the **`cost`** oldest hits in the window (FIFO), matching the increment order used by
   * skip-failed/skip-successful response handlers so concurrent requests undo the correct slots.
   */
  private decrementSliding(key: string, cost = 1): void {
    const ts = this.sliding.get(key);
    if (!ts || ts.length === 0) {
      return;
    }
    let n = Math.min(cost, ts.length);
    while (n-- > 0) {
      ts.shift();
    }
    if (ts.length === 0) {
      this.sliding.delete(key);
    } else {
      this.sliding.set(key, ts);
    }
  }

  /** Removes the **`cost`** newest hits (LIFO) — used to undo a failed increment probe without evicting older usage. */
  private decrementSlidingFromEnd(key: string, cost = 1): void {
    const ts = this.sliding.get(key);
    if (!ts || ts.length === 0) {
      return;
    }
    let n = Math.min(cost, ts.length);
    while (n-- > 0) {
      ts.pop();
    }
    if (ts.length === 0) {
      this.sliding.delete(key);
    } else {
      this.sliding.set(key, ts);
    }
  }

  // --- Fixed window ---------------------------------------------------------

  private incrementFixed(key: string, maxOverride?: number, cost = 1): RateLimitResult {
    const cap = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    let entry = this.fixed.get(key);

    if (!entry || now >= entry.resetTime) {
      entry = { count: cost, resetTime: now + this.windowMs };
    } else {
      entry = { count: entry.count + cost, resetTime: entry.resetTime };
    }

    this.fixed.set(key, entry);

    const totalHits = entry.count;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
    const resetTime = new Date(entry.resetTime);

    return { totalHits, remaining, resetTime, isBlocked };
  }

  private decrementFixed(key: string, cost = 1): void {
    const entry = this.fixed.get(key);
    if (!entry || entry.count <= 0) {
      return;
    }
    const next = entry.count - cost;
    if (next <= 0) {
      this.fixed.delete(key);
    } else {
      this.fixed.set(key, { count: next, resetTime: entry.resetTime });
    }
  }

  // --- Token bucket ---------------------------------------------------------

  private incrementTokenBucket(key: string, cost = 1): RateLimitResult {
    const now = Date.now();
    let state = this.buckets.get(key);

    if (!state) {
      state = { tokens: this.bucketSize, lastRefill: now };
    }

    let { tokens, lastRefill } = state;

    // Refill in whole intervals so `lastRefill` stays aligned with the schedule.
    const elapsed = now - lastRefill;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    if (intervals > 0) {
      tokens = Math.min(this.bucketSize, tokens + intervals * this.tokensPerInterval);
      lastRefill += intervals * this.refillIntervalMs;
    }

    if (tokens >= cost) {
      tokens -= cost;
      this.buckets.set(key, { tokens, lastRefill });

      const remaining = tokens;
      const totalHits = this.bucketSize - remaining;
      const resetTime = new Date(lastRefill + this.refillIntervalMs);

      return {
        totalHits,
        remaining,
        resetTime,
        isBlocked: false,
      };
    }

    // Blocked: next token arrives at the upcoming refill boundary.
    const nextRefillAt = lastRefill + this.refillIntervalMs;
    this.buckets.set(key, { tokens, lastRefill });

    return {
      totalHits: this.bucketSize,
      remaining: 0,
      resetTime: new Date(nextRefillAt),
      isBlocked: true,
    };
  }

  private decrementTokenBucket(key: string, cost = 1): void {
    const state = this.buckets.get(key);
    if (!state) {
      return;
    }
    const tokens = Math.min(this.bucketSize, state.tokens + cost);
    this.buckets.set(key, { tokens, lastRefill: state.lastRefill });
  }

  /** Same refill math as {@link MemoryStore.incrementTokenBucket} (without mutating). */
  private refillBucketStateForNow(state: BucketEntry, now: number): { tokens: number; lastRefill: number } {
    let { tokens, lastRefill } = state;
    const elapsed = now - lastRefill;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    if (intervals > 0) {
      tokens = Math.min(this.bucketSize, tokens + intervals * this.tokensPerInterval);
      lastRefill += intervals * this.refillIntervalMs;
    }
    return { tokens, lastRefill };
  }

  /** Matches {@link MemoryStore.purgeBuckets} eligibility. */
  private isBucketIdleFullPurgeable(v: BucketEntry, now: number): boolean {
    const idleMs = 10 * this.refillIntervalMs;
    return v.tokens >= this.bucketSize && now - v.lastRefill > idleMs;
  }

  // --- Cleanup --------------------------------------------------------------

  /**
   * Drops stale keys and trims sliding-window timestamps.
   * Runs on the background interval and can be invoked after mutations if needed.
   */
  private purgeExpired(): void {
    const now = Date.now();

    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        this.purgeSliding(now);
        break;
      case RateLimitStrategy.FIXED_WINDOW:
        this.purgeFixed(now);
        break;
      case RateLimitStrategy.TOKEN_BUCKET:
        this.purgeBuckets(now);
        break;
      default:
        break;
    }
  }

  private purgeSliding(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [k, ts] of this.sliding.entries()) {
      const filtered = ts.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.sliding.delete(k);
      } else if (filtered.length !== ts.length) {
        this.sliding.set(k, filtered);
      }
    }
  }

  private purgeFixed(now: number): void {
    for (const [k, v] of this.fixed.entries()) {
      if (now >= v.resetTime) {
        this.fixed.delete(k);
      }
    }
  }

  /**
   * Remove idle full buckets to cap memory (activity is tracked via `lastRefill`).
   */
  private purgeBuckets(now: number): void {
    const idleMs = 10 * this.refillIntervalMs;
    for (const [k, v] of this.buckets.entries()) {
      if (v.tokens >= this.bucketSize && now - v.lastRefill > idleMs) {
        this.buckets.delete(k);
      }
    }
  }
}
