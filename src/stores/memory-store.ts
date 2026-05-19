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
 * Optional key-cap and eviction hooks shared by all {@link MemoryStore} strategy options.
 *
 * @since 4.0.0
 */
export interface MemoryStoreLruOptions {
  /**
   * Maximum number of distinct keys to track in memory.
   * When this limit is reached, the least-recently-used key is evicted
   * to make room for the new one.
   *
   * Default: 100_000. This protects against unbounded memory growth from
   * high-cardinality or malicious keys (e.g., an attacker spoofing IPs
   * through a misconfigured reverse proxy).
   *
   * Set to 0 to disable the cap entirely (unbounded — NOT recommended
   * for production). Set to a specific number for custom budgets.
   *
   * Eviction fires the `onEvict` callback if provided.
   */
  maxKeys?: number;

  /**
   * Callback fired when a key is evicted due to maxKeys pressure.
   * Useful for metrics and debugging high-cardinality bugs.
   */
  onEvict?: (key: string, reason: 'lru-cap' | 'expired') => void;

  /**
   * Optional alert when **`lru-cap`** evictions spike inside a sliding time window (high-cardinality / attack signal).
   *
   * Counts **only LRU evictions** from {@link MemoryStoreEvictionBurstSnapshot.evictionsInWindow}, not TTL /
   * `expired` cleanups triggered while making room under **`maxKeys`** pressure.
   *
   * @since 4.2.0
   */
  evictionVelocityAlert?: MemoryStoreEvictionVelocityAlert;
}

/**
 * Rolling-window eviction burst detector for {@link MemoryStoreEvictionBurstSnapshot}.
 *
 * @since 4.2.0
 */
export interface MemoryStoreEvictionVelocityAlert {
  /**
   * Rolling window length for counting LRU evictions. Default **`30_000`** ms.
   */
  windowMs?: number;
  /**
   * Invoke **`callback`** when at least this many LRU evictions land inside the rolling window.
   */
  minEvictions: number;
  /**
   * Minimum ms between **`callback`** invocations while the burst condition holds. Default **`5_000`**.
   */
  cooldownMs?: number;
  callback: (snapshot: MemoryStoreEvictionBurstSnapshot) => void;
}

/**
 * @since 4.2.0
 */
export interface MemoryStoreEvictionBurstSnapshot {
  windowMs: number;
  evictionsInWindow: number;
  oldestEvictionAtMs: number;
  newestEvictionAtMs: number;
}

/**
 * Constructor options for window-based strategies (sliding or fixed).
 *
 * @description Use with {@link RateLimitStrategy.SLIDING_WINDOW} or {@link RateLimitStrategy.FIXED_WINDOW}.
 * @see {@link MemoryStoreTokenBucketOptions}
 * @see {@link RedisStore} — distributed alternative
 * @since 1.0.0
 */
export type MemoryStoreWindowOptions = MemoryStoreLruOptions & {
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
export type MemoryStoreTokenBucketOptions = MemoryStoreLruOptions & {
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

/** Sliding-window entry: hit timestamps + optional wall-clock expiry (PEXPIREAT-style). */
type SlidingKeyState = { stamps: number[]; wallExpiresAt?: number };

/** Per-key state for one {@link MemoryStore} instance (exactly one strategy). */
type KeyState = SlidingKeyState | FixedEntry | BucketEntry;

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
 * All keys are stored in a single {@link Map} (`state`) in LRU insertion order for eviction under `maxKeys`.
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

  /**
   * Single map of key → strategy-specific state. Insertion order = LRU (oldest first).
   */
  private readonly state = new Map<string, KeyState>();

  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Maximum distinct keys (0 = unlimited). Default 100_000.
   */
  private readonly maxKeys: number;

  private readonly onEvict?: MemoryStoreOptions['onEvict'];

  private readonly evictionVelocityAlertCfg?:
    | (MemoryStoreEvictionVelocityAlert & { windowMs: number; cooldownMs: number })
    | undefined;

  /** Timestamps for recent LRU-cap evictions (rolling window telemetry). */
  private evictionLRUTimestampsMs: number[] = [];

  private evictionVelocityLastEmitMs = 0;

  /** Count of LRU evictions (`lru-cap`) since this instance was constructed. Not reset by {@link MemoryStore.resetAll}. */
  private _totalEvictions = 0;

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
      this.cleanupEveryMs = Math.max(1, options.interval);
    } else {
      this.windowMs = sanitizeWindowMs(options.windowMs, 60_000);
      this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
      this.tokensPerInterval = 0;
      this.refillIntervalMs = 0;
      this.bucketSize = 0;
      this.cleanupEveryMs = Math.max(1, this.windowMs);
    }

    this.maxKeys = options.maxKeys === undefined ? 100_000 : Math.max(0, Math.floor(options.maxKeys));
    this.onEvict = options.onEvict;

    const evCfg = options.evictionVelocityAlert;
    this.evictionVelocityAlertCfg =
      evCfg?.callback !== undefined
        ? {
            windowMs: sanitizeWindowMs(evCfg.windowMs ?? 30_000, 30_000),
            minEvictions: Math.max(1, Math.floor(evCfg.minEvictions)),
            cooldownMs: Math.max(0, Math.floor(evCfg.cooldownMs ?? 5_000)),
            callback: evCfg.callback,
          }
        : undefined;

    this.cleanupTimer = setInterval(() => {
      this.purgeExpired();
    }, this.cleanupEveryMs);

    if (
      typeof this.cleanupTimer === 'object' &&
      this.cleanupTimer !== null &&
      'unref' in this.cleanupTimer
    ) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Snapshot metrics for the in-memory key table.
   *
   * @description
   * - **`totalEvictions`**: cumulative LRU evictions (`lru-cap`) since construction; **not** cleared by {@link MemoryStore.resetAll}.
   * - **`activeKeys`**: current `state.size` (distinct keys in the map).
   *
   * @since 4.0.0
   */
  getMetrics(): { activeKeys: number; totalEvictions: number; maxKeys: number } {
    return {
      activeKeys: this.state.size,
      totalEvictions: this._totalEvictions,
      maxKeys: this.maxKeys,
    };
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
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        this.state.delete(key);
        break;
      case RateLimitStrategy.FIXED_WINDOW: {
        const now = Date.now();
        this.state.set(key, { count: 0, resetTime: now + this.windowMs });
        break;
      }
      case RateLimitStrategy.TOKEN_BUCKET:
        this.state.set(key, { tokens: this.bucketSize, lastRefill: Date.now() });
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
   * @description Clears the cleanup timer and empties all maps.
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.state.clear();
    return Promise.resolve();
  }

  /**
   * @description Read-only snapshot: does **not** mutate internal maps (except sliding expiry cleanup). **Sliding window** re-applies the current cutoff (`now - windowMs`) before counting, so stale timestamps are excluded. **Token bucket** uses {@link MemoryStore.refillBucketStateForNow} and {@link MemoryStore.isBucketIdleFullPurgeable} — same logic as increment and purge. **Fixed window** omits expired slices. Returns all keys with **non-expired** quota state.
   * @returns Map of key → `{ totalHits, resetTime }` consistent with {@link RateLimitResult} semantics for each strategy.
   * @since 1.3.2
   */
  getActiveKeys(): Map<string, RateLimitActiveKeyEntry> {
    const now = Date.now();
    const out = new Map<string, RateLimitActiveKeyEntry>();

    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW: {
        const cutoff = now - this.windowMs;
        for (const k of Array.from(this.state.keys())) {
          this.clearSlidingWallExpiryIfExpired(k, now);
          const cur = this.getSlidingState(k);
          if (!cur) {
            continue;
          }
          const trimmed = cur.stamps.filter((t) => t > cutoff);
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
        for (const [k, v] of this.state.entries()) {
          const e = v as FixedEntry;
          if (now >= e.resetTime) {
            continue;
          }
          out.set(k, {
            totalHits: e.count,
            resetTime: new Date(e.resetTime),
          });
        }
        break;
      }
      case RateLimitStrategy.TOKEN_BUCKET: {
        for (const [k, v] of this.state.entries()) {
          const b = v as BucketEntry;
          if (this.isBucketIdleFullPurgeable(b, now)) {
            continue;
          }
          const { tokens, lastRefill } = this.refillBucketStateForNow(b, now);
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
   * @description Does **not** reset {@link MemoryStore.getMetrics}.`totalEvictions` — that counter is lifetime-for-instance.
   * @since 1.3.2
   */
  resetAll(): void {
    this.state.clear();
  }

  /**
   * @inheritdoc
   * @description Does not trim sliding timestamps or consume tokens — read-only aside from sliding wall-clock expiry cleanup.
   */
  async get(key: string): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null> {
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        return Promise.resolve(this.getSlidingReadOnly(key));
      case RateLimitStrategy.FIXED_WINDOW:
        return Promise.resolve(this.getFixedReadOnly(key));
      case RateLimitStrategy.TOKEN_BUCKET:
        return Promise.resolve(this.getTokenBucketReadOnly(key));
      default: {
        const exhaustive: never = this.strategy;
        return Promise.reject(new Error(`Unsupported strategy: ${String(exhaustive)}`));
      }
    }
  }

  /**
   * @inheritdoc
   */
  async set(
    key: string,
    totalHits: number,
    expiresAt?: Date,
  ): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  }> {
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW:
        return Promise.resolve(this.setSliding(key, totalHits, expiresAt));
      case RateLimitStrategy.FIXED_WINDOW:
        return Promise.resolve(this.setFixed(key, totalHits, expiresAt));
      case RateLimitStrategy.TOKEN_BUCKET:
        return Promise.resolve(this.setTokenBucket(key, totalHits, expiresAt));
      default: {
        const exhaustive: never = this.strategy;
        return Promise.reject(new Error(`Unsupported strategy: ${String(exhaustive)}`));
      }
    }
  }

  /**
   * @inheritdoc
   */
  async delete(key: string): Promise<boolean> {
    return Promise.resolve(this.state.delete(key));
  }

  private getSlidingState(key: string): SlidingKeyState | undefined {
    const v = this.state.get(key);
    return v !== undefined && 'stamps' in v ? (v as SlidingKeyState) : undefined;
  }

  private setSlidingState(key: string, s: SlidingKeyState): void {
    this.state.set(key, s);
  }

  private deleteKeyData(key: string, reason: 'lru-cap' | 'expired'): void {
    if (!this.state.has(key)) {
      return;
    }
    this.state.delete(key);
    this.onEvict?.(key, reason);
  }

  private noteLruBurstEviction(now: number): void {
    const cfg = this.evictionVelocityAlertCfg;
    if (!cfg) {
      return;
    }
    this.evictionLRUTimestampsMs.push(now);
    const cutoff = now - cfg.windowMs;
    while (this.evictionLRUTimestampsMs.length > 0 && this.evictionLRUTimestampsMs[0]! < cutoff) {
      this.evictionLRUTimestampsMs.shift();
    }
    if (this.evictionLRUTimestampsMs.length < cfg.minEvictions) {
      return;
    }
    if (cfg.cooldownMs > 0 && now - this.evictionVelocityLastEmitMs < cfg.cooldownMs) {
      return;
    }
    this.evictionVelocityLastEmitMs = now;
    const oldest = this.evictionLRUTimestampsMs[0]!;
    const newest = this.evictionLRUTimestampsMs[this.evictionLRUTimestampsMs.length - 1]!;
    try {
      cfg.callback({
        windowMs: cfg.windowMs,
        evictionsInWindow: this.evictionLRUTimestampsMs.length,
        oldestEvictionAtMs: oldest,
        newestEvictionAtMs: newest,
      });
    } catch {
      /* ignore consumer errors — never disrupt eviction */
    }
  }

  private evictOldest(): void {
    const first = this.state.keys().next();
    if (first.done) {
      return;
    }
    const oldestKey = first.value;
    const now = Date.now();
    this.state.delete(oldestKey);
    this._totalEvictions++;
    this.onEvict?.(oldestKey, 'lru-cap');
    this.noteLruBurstEviction(now);
  }

  /**
   * True if this key's quota state is expired for the active strategy (wall TTL, window slice, idle bucket, etc.).
   * Used when making room for a new key: expired heads are removed as `expired`, not LRU.
   */
  private isEntryExpiredAtKey(key: string, now: number): boolean {
    switch (this.strategy) {
      case RateLimitStrategy.SLIDING_WINDOW: {
        const s = this.getSlidingState(key);
        if (!s) {
          return false;
        }
        if (s.wallExpiresAt !== undefined && now >= s.wallExpiresAt) {
          return true;
        }
        const cutoff = now - this.windowMs;
        return s.stamps.every((t) => t <= cutoff);
      }
      case RateLimitStrategy.FIXED_WINDOW: {
        const e = this.state.get(key) as FixedEntry | undefined;
        return e !== undefined && now >= e.resetTime;
      }
      case RateLimitStrategy.TOKEN_BUCKET: {
        const b = this.state.get(key) as BucketEntry | undefined;
        return b !== undefined && this.isBucketIdleFullPurgeable(b, now);
      }
      default: {
        return false;
      }
    }
  }

  /** Enforce capacity before inserting a key that is not yet in `state`. */
  private ensureRoomForNewKey(incomingKey: string): void {
    if (this.maxKeys === 0 || this.state.has(incomingKey)) {
      return;
    }
    const now = Date.now();
    while (this.state.size >= this.maxKeys) {
      const first = this.state.keys().next();
      if (first.done) {
        return;
      }
      const head = first.value;
      if (this.isEntryExpiredAtKey(head, now)) {
        this.deleteKeyData(head, 'expired');
        continue;
      }
      this.evictOldest();
    }
  }

  /**
   * Move key to LRU tail (MRU) if present. No-op when `maxKeys === 0`.
   */
  private touchKey(key: string): void {
    if (this.maxKeys === 0) {
      return;
    }
    const v = this.state.get(key);
    if (v === undefined) {
      return;
    }
    this.state.delete(key);
    this.state.set(key, v);
  }

  // --- Sliding window -----------------------------------------------------

  private clearSlidingWallExpiryIfExpired(key: string, now: number): void {
    const s = this.getSlidingState(key);
    if (s?.wallExpiresAt !== undefined && now >= s.wallExpiresAt) {
      this.deleteKeyData(key, 'expired');
    }
  }

  private getSlidingReadOnly(key: string): {
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null {
    const now = Date.now();
    this.clearSlidingWallExpiryIfExpired(key, now);
    const cap = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const cutoff = now - this.windowMs;
    const cur = this.getSlidingState(key);
    if (!cur) {
      return null;
    }
    const trimmed = cur.stamps.filter((ts) => ts > cutoff);
    if (trimmed.length === 0) {
      return null;
    }
    const totalHits = trimmed.length;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
    const oldest = trimmed[0]!;
    const resetTime = new Date(oldest + this.windowMs);
    this.touchKey(key);
    return { totalHits, remaining, resetTime, isBlocked };
  }

  private setSliding(key: string, totalHits: number, expiresAt?: Date): RateLimitResult {
    const now = Date.now();
    const cap = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const n = Math.max(0, Math.floor(totalHits));
    const stamps = Array.from({ length: n }, () => now);
    const next: SlidingKeyState = {
      stamps,
      ...(expiresAt !== undefined ? { wallExpiresAt: expiresAt.getTime() } : {}),
    };
    if (!this.state.has(key)) {
      this.ensureRoomForNewKey(key);
    }
    if (this.maxKeys > 0 && this.state.has(key)) {
      this.state.delete(key);
    }
    this.setSlidingState(key, next);
    const isBlocked = n > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - n);
    const resetTime = new Date(now + this.windowMs);
    return { totalHits: n, remaining, resetTime, isBlocked };
  }

  private getFixedReadOnly(key: string): {
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null {
    const now = Date.now();
    const cap = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const entry = this.state.get(key) as FixedEntry | undefined;
    if (!entry || now >= entry.resetTime) {
      return null;
    }
    const totalHits = entry.count;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
    const resetTime = new Date(entry.resetTime);
    this.touchKey(key);
    return { totalHits, remaining, resetTime, isBlocked };
  }

  private setFixed(key: string, totalHits: number, expiresAt?: Date): RateLimitResult {
    const now = Date.now();
    const cap = sanitizeRateLimitCap(this.maxRequests, this.maxRequests);
    const n = Math.max(0, Math.floor(totalHits));
    const resetTimeMs = expiresAt?.getTime() ?? now + this.windowMs;
    if (!this.state.has(key)) {
      this.ensureRoomForNewKey(key);
    }
    if (this.maxKeys > 0 && this.state.has(key)) {
      this.state.delete(key);
    }
    this.state.set(key, { count: n, resetTime: resetTimeMs });
    const isBlocked = n > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - n);
    return { totalHits: n, remaining, resetTime: new Date(resetTimeMs), isBlocked };
  }

  private getTokenBucketReadOnly(key: string): {
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null {
    const raw = this.state.get(key) as BucketEntry | undefined;
    if (!raw) {
      return null;
    }
    const now = Date.now();
    if (this.isBucketIdleFullPurgeable(raw, now)) {
      return null;
    }
    const { tokens, lastRefill } = this.refillBucketStateForNow(raw, now);
    const remaining = tokens;
    const totalHits = this.bucketSize - remaining;
    const isBlocked = remaining === 0 && totalHits >= this.bucketSize;
    this.touchKey(key);
    return {
      totalHits,
      remaining,
      resetTime: new Date(lastRefill + this.refillIntervalMs),
      isBlocked,
    };
  }

  private setTokenBucket(key: string, totalHits: number, _expiresAt?: Date): RateLimitResult {
    void _expiresAt;
    const now = Date.now();
    const cap = this.bucketSize;
    const th = Math.max(0, totalHits);
    const isBlocked = th >= cap;
    const tokens = isBlocked ? 0 : Math.max(0, cap - th);
    const totalHitsOut = isBlocked ? cap : th;
    if (!this.state.has(key)) {
      this.ensureRoomForNewKey(key);
    }
    if (this.maxKeys > 0 && this.state.has(key)) {
      this.state.delete(key);
    }
    this.state.set(key, { tokens, lastRefill: now });
    return {
      totalHits: totalHitsOut,
      remaining: tokens,
      resetTime: new Date(now + this.refillIntervalMs),
      isBlocked,
    };
  }

  private incrementSliding(key: string, maxOverride?: number, cost = 1): RateLimitResult {
    const cap = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    this.clearSlidingWallExpiryIfExpired(key, now);

    let entry = this.getSlidingState(key);
    if (entry !== undefined) {
      this.state.delete(key);
      delete entry.wallExpiresAt;
    } else {
      this.ensureRoomForNewKey(key);
      entry = { stamps: [] };
    }

    const cutoff = now - this.windowMs;
    const trimmed = entry.stamps.filter((ts) => ts > cutoff);
    for (let i = 0; i < cost; i++) {
      trimmed.push(now);
    }
    entry.stamps = trimmed;

    this.setSlidingState(key, entry);

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
    const cur = this.getSlidingState(key);
    if (!cur || cur.stamps.length === 0) {
      return;
    }
    const ts = [...cur.stamps];
    let n = Math.min(cost, ts.length);
    while (n-- > 0) {
      ts.shift();
    }
    if (ts.length === 0) {
      this.state.delete(key);
    } else {
      this.setSlidingState(key, { ...cur, stamps: ts });
    }
  }

  /** Removes the **`cost`** newest hits (LIFO) — used to undo a failed increment probe without evicting older usage. */
  private decrementSlidingFromEnd(key: string, cost = 1): void {
    const cur = this.getSlidingState(key);
    if (!cur || cur.stamps.length === 0) {
      return;
    }
    const ts = [...cur.stamps];
    let n = Math.min(cost, ts.length);
    while (n-- > 0) {
      ts.pop();
    }
    if (ts.length === 0) {
      this.state.delete(key);
    } else {
      this.setSlidingState(key, { ...cur, stamps: ts });
    }
  }

  // --- Fixed window ---------------------------------------------------------

  private incrementFixed(key: string, maxOverride?: number, cost = 1): RateLimitResult {
    const cap = sanitizeRateLimitCap(maxOverride ?? this.maxRequests, this.maxRequests);
    const now = Date.now();
    let entry = this.state.get(key) as FixedEntry | undefined;

    if (!entry || now >= entry.resetTime) {
      if (!entry) {
        this.ensureRoomForNewKey(key);
      }
      entry = { count: cost, resetTime: now + this.windowMs };
    } else {
      entry = { count: entry.count + cost, resetTime: entry.resetTime };
    }

    if (this.maxKeys > 0 && this.state.has(key)) {
      this.state.delete(key);
    }
    this.state.set(key, entry);

    const totalHits = entry.count;
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
    const resetTime = new Date(entry.resetTime);

    return { totalHits, remaining, resetTime, isBlocked };
  }

  private decrementFixed(key: string, cost = 1): void {
    const entry = this.state.get(key) as FixedEntry | undefined;
    if (!entry || entry.count <= 0) {
      return;
    }
    const next = entry.count - cost;
    if (next <= 0) {
      this.state.delete(key);
    } else {
      this.state.set(key, { count: next, resetTime: entry.resetTime });
    }
  }

  // --- Token bucket ---------------------------------------------------------

  private incrementTokenBucket(key: string, cost = 1): RateLimitResult {
    const now = Date.now();
    let bucketState = this.state.get(key) as BucketEntry | undefined;

    if (!bucketState) {
      this.ensureRoomForNewKey(key);
      bucketState = { tokens: this.bucketSize, lastRefill: now };
    }

    let { tokens, lastRefill } = bucketState;

    const elapsed = now - lastRefill;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    if (intervals > 0) {
      tokens = Math.min(this.bucketSize, tokens + intervals * this.tokensPerInterval);
      lastRefill += intervals * this.refillIntervalMs;
    }

    if (tokens >= cost) {
      tokens -= cost;
      if (this.maxKeys > 0 && this.state.has(key)) {
        this.state.delete(key);
      }
      this.state.set(key, { tokens, lastRefill });

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

    const nextRefillAt = lastRefill + this.refillIntervalMs;
    if (this.maxKeys > 0 && this.state.has(key)) {
      this.state.delete(key);
    }
    this.state.set(key, { tokens, lastRefill });

    return {
      totalHits: this.bucketSize,
      remaining: 0,
      resetTime: new Date(nextRefillAt),
      isBlocked: true,
    };
  }

  private decrementTokenBucket(key: string, cost = 1): void {
    const st = this.state.get(key) as BucketEntry | undefined;
    if (!st) {
      return;
    }
    const tokens = Math.min(this.bucketSize, st.tokens + cost);
    this.state.set(key, { tokens, lastRefill: st.lastRefill });
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
    for (const [k, s] of Array.from(this.state.entries())) {
      const sk = s as SlidingKeyState;
      if (!('stamps' in sk)) {
        continue;
      }
      if (sk.wallExpiresAt !== undefined && now >= sk.wallExpiresAt) {
        this.deleteKeyData(k, 'expired');
      }
    }
    const cutoff = now - this.windowMs;
    for (const k of Array.from(this.state.keys())) {
      const sk = this.getSlidingState(k);
      if (!sk) {
        continue;
      }
      const filtered = sk.stamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.deleteKeyData(k, 'expired');
      } else if (filtered.length !== sk.stamps.length) {
        this.setSlidingState(k, { ...sk, stamps: filtered });
      }
    }
  }

  private purgeFixed(now: number): void {
    for (const k of Array.from(this.state.keys())) {
      const v = this.state.get(k) as FixedEntry | undefined;
      if (v !== undefined && now >= v.resetTime) {
        this.deleteKeyData(k, 'expired');
      }
    }
  }

  /**
   * Remove idle full buckets to cap memory (activity is tracked via `lastRefill`).
   */
  private purgeBuckets(now: number): void {
    const idleMs = 10 * this.refillIntervalMs;
    for (const k of Array.from(this.state.keys())) {
      const v = this.state.get(k) as BucketEntry | undefined;
      if (v !== undefined && v.tokens >= this.bucketSize && now - v.lastRefill > idleMs) {
        this.deleteKeyData(k, 'expired');
      }
    }
  }
}
