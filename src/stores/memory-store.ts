import type {
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';

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

type FixedEntry = { count: number; resetTime: number };
type BucketEntry = { tokens: number; lastRefill: number };

/**
 * In-process {@link RateLimitStore} (not shared across Node processes).
 *
 * @description
 * - **Sliding window**: request timestamps per key; counts hits inside `windowMs`.
 * - **Fixed window**: counter + window end; resets when the slice expires.
 * - **Token bucket**: refills tokens on a schedule; consumes one token per allowed hit.
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
   * @inheritdoc
   * @param key - Client identifier.
   * @param options - Optional `{ maxRequests }` override for sliding/fixed window.
   * @returns Synchronous promise with {@link RateLimitResult}.
   * @throws If strategy is not handled (should be unreachable).
   */
  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        return Promise.resolve(this.incrementSliding(key, options?.maxRequests));
      case RateLimitStrategy.FIXED_WINDOW:
        return Promise.resolve(this.incrementFixed(key, options?.maxRequests));
      case RateLimitStrategy.TOKEN_BUCKET:
        return Promise.resolve(this.incrementTokenBucket(key));
      default: {
        const exhaustive: never = this.strategy;
        return Promise.reject(new Error(`Unsupported strategy: ${String(exhaustive)}`));
      }
    }
  }

  /**
   * @inheritdoc
   * @param key - Same key used for {@link MemoryStore.increment}.
   * @throws If strategy is not handled (should be unreachable).
   */
  async decrement(key: string): Promise<void> {
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        this.decrementSliding(key);
        break;
      case RateLimitStrategy.FIXED_WINDOW:
        this.decrementFixed(key);
        break;
      case RateLimitStrategy.TOKEN_BUCKET:
        this.decrementTokenBucket(key);
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

  // --- Sliding window -----------------------------------------------------

  private incrementSliding(key: string, maxOverride?: number): RateLimitResult {
    const cap = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const prev = this.sliding.get(key) ?? [];
    const trimmed = prev.filter((ts) => ts > cutoff);
    trimmed.push(now);
    this.sliding.set(key, trimmed);

    const totalHits = trimmed.length;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);

    const oldest = trimmed[0];
    const resetTime = new Date(oldest !== undefined ? oldest + this.windowMs : now + this.windowMs);

    return { totalHits, remaining, resetTime, isBlocked };
  }

  /**
   * Removes the **oldest** hit in the window (FIFO), matching the increment order used by
   * skip-failed/skip-successful response handlers so concurrent requests undo the correct slot.
   */
  private decrementSliding(key: string): void {
    const ts = this.sliding.get(key);
    if (!ts || ts.length === 0) {
      return;
    }
    ts.shift();
    if (ts.length === 0) {
      this.sliding.delete(key);
    } else {
      this.sliding.set(key, ts);
    }
  }

  // --- Fixed window ---------------------------------------------------------

  private incrementFixed(key: string, maxOverride?: number): RateLimitResult {
    const cap = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    let entry = this.fixed.get(key);

    if (!entry || now >= entry.resetTime) {
      entry = { count: 1, resetTime: now + this.windowMs };
    } else {
      entry = { count: entry.count + 1, resetTime: entry.resetTime };
    }

    this.fixed.set(key, entry);

    const totalHits = entry.count;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
    const resetTime = new Date(entry.resetTime);

    return { totalHits, remaining, resetTime, isBlocked };
  }

  private decrementFixed(key: string): void {
    const entry = this.fixed.get(key);
    if (!entry || entry.count <= 0) {
      return;
    }
    const next = entry.count - 1;
    if (next <= 0) {
      this.fixed.delete(key);
    } else {
      this.fixed.set(key, { count: next, resetTime: entry.resetTime });
    }
  }

  // --- Token bucket ---------------------------------------------------------

  private incrementTokenBucket(key: string): RateLimitResult {
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

    if (tokens >= 1) {
      tokens -= 1;
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

  private decrementTokenBucket(key: string): void {
    const state = this.buckets.get(key);
    if (!state) {
      return;
    }
    const tokens = Math.min(this.bucketSize, state.tokens + 1);
    this.buckets.set(key, { tokens, lastRefill: state.lastRefill });
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
