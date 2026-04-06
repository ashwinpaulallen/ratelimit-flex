import { COMPOSED_UNWRAP } from '../composition/composed-store-brand.js';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../types/index.js';
import type { InMemoryShieldOptions, ShieldEntry, ShieldMetrics } from './types.js';

export class InMemoryShield implements RateLimitStore {
  private readonly inner: RateLimitStore;
  private readonly blockOnConsumed: number;
  /** `null` = use {@link RateLimitResult.resetTime} from the store */
  private readonly blockDurationMs: number | null;
  private readonly maxBlockedKeys: number;
  private readonly onBlock?: InMemoryShieldOptions['onBlock'];
  private readonly onExpire?: InMemoryShieldOptions['onExpire'];
  private readonly onEvict?: InMemoryShieldOptions['onEvict'];
  private readonly onShieldHit?: InMemoryShieldOptions['onShieldHit'];

  /**
   * The block cache. Uses a Map for O(1) lookup, insertion-order iteration
   * (for LRU eviction), and easy size tracking.
   */
  private readonly cache: Map<string, ShieldEntry>;

  /** Proactive sweep timer */
  private sweepTimer: ReturnType<typeof setInterval> | null;

  /** Metrics counters */
  private _storeCallsSaved: number;
  private _storeCalls: number;
  private _totalKeysBlocked: number;
  private _totalKeysExpired: number;
  private _totalKeysEvicted: number;

  constructor(innerStore: RateLimitStore, options: InMemoryShieldOptions) {
    if (!Number.isFinite(options.blockOnConsumed) || options.blockOnConsumed < 1) {
      throw new Error('InMemoryShield: blockOnConsumed must be a finite number >= 1');
    }
    const maxBlockedKeys = options.maxBlockedKeys ?? 10_000;
    if (!Number.isFinite(maxBlockedKeys) || maxBlockedKeys < 0) {
      throw new Error('InMemoryShield: maxBlockedKeys must be a finite number >= 0');
    }
    const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
    if (options.blockDurationMs !== undefined) {
      if (!Number.isFinite(options.blockDurationMs) || options.blockDurationMs < 0) {
        throw new Error('InMemoryShield: blockDurationMs must be a finite number >= 0');
      }
    }

    this.inner = innerStore;
    this.blockOnConsumed = options.blockOnConsumed;
    this.blockDurationMs =
      options.blockDurationMs === undefined ? null : options.blockDurationMs;
    this.maxBlockedKeys = maxBlockedKeys;
    this.onBlock = options.onBlock;
    this.onExpire = options.onExpire;
    this.onEvict = options.onEvict;
    this.onShieldHit = options.onShieldHit;

    this.cache = new Map();
    this.sweepTimer = null;
    this._storeCallsSaved = 0;
    this._storeCalls = 0;
    this._totalKeysBlocked = 0;
    this._totalKeysExpired = 0;
    this._totalKeysEvicted = 0;

    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweep();
      }, sweepIntervalMs);
      if (
        typeof this.sweepTimer === 'object' &&
        this.sweepTimer !== null &&
        'unref' in this.sweepTimer
      ) {
        this.sweepTimer.unref();
      }
    }
  }

  /**
   * Lets {@link isComposedStoreBrand} detect a {@link ComposedStore} behind this shield (e.g. `inMemoryBlock` + `limits`).
   */
  [COMPOSED_UNWRAP](): RateLimitStore {
    return this.inner;
  }

  /**
   * The hot path. This is where the performance gain happens.
   *
   * 1. Check if key is in cache AND not expired → return cached blocked result (O(1), ~0.01ms)
   * 2. If expired → remove from cache, fall through to store
   * 3. If not in cache → call inner.increment()
   * 4. If store result has totalHits >= blockOnConsumed → cache it
   * 5. Return the result
   */
  async increment(
    key: string,
    options?: RateLimitIncrementOptions,
  ): Promise<RateLimitResult & { shielded?: boolean }> {
    const entry = this.cache.get(key);
    if (entry) {
      const now = Date.now();
      if (now < entry.expiresAt) {
        this._storeCallsSaved++;
        this.onShieldHit?.(key);
        return { ...entry.cachedResult, shielded: true };
      }
      this.cache.delete(key);
      this._totalKeysExpired++;
      this.onExpire?.(key);
    }

    this._storeCalls++;
    const result = await this.inner.increment(key, options);

    if (result.totalHits >= this.blockOnConsumed) {
      this.cacheBlock(key, result);
    }

    return result;
  }

  /**
   * Add a key to the block cache.
   */
  private cacheBlock(
    key: string,
    result: {
      totalHits: number;
      remaining: number;
      resetTime: Date;
      isBlocked: boolean;
    },
  ): void {
    let expiresAt: number;
    if (this.blockDurationMs !== null && this.blockDurationMs > 0) {
      expiresAt = Date.now() + this.blockDurationMs;
    } else {
      expiresAt = result.resetTime.getTime();
    }

    if (this.maxBlockedKeys > 0 && this.cache.size >= this.maxBlockedKeys) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this._totalKeysEvicted++;
        this.onEvict?.(oldestKey);
      }
    }

    const entry: ShieldEntry = {
      blockedAt: Date.now(),
      expiresAt,
      cachedResult: {
        totalHits: result.totalHits,
        remaining: Math.max(0, result.remaining),
        resetTime: result.resetTime,
        isBlocked: true,
      },
    };

    this.cache.set(key, entry);
    this._totalKeysBlocked++;
    this.onBlock?.(key, result.totalHits, new Date(expiresAt));
  }

  /**
   * Decrement passes through to the inner store AND removes the key
   * from the cache (if a decrement happens, the key may no longer be blocked).
   */
  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    this.cache.delete(key);
    return this.inner.decrement(key, options);
  }

  /**
   * Reset passes through AND removes from cache.
   */
  async reset(key: string): Promise<void> {
    this.cache.delete(key);
    return this.inner.reset(key);
  }

  /**
   * Delete passes through AND removes from cache.
   */
  async delete(key: string): Promise<boolean> {
    this.cache.delete(key);
    if (this.inner.delete) {
      return this.inner.delete(key);
    }
    await this.inner.reset(key);
    return true;
  }

  /**
   * Get passes through to the inner store (reads don't need shielding).
   * But if the key is in the cache, return the cached state instead
   * (faster, and avoids a store call for a known-blocked key).
   */
  async get(key: string): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null> {
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.cachedResult;
    }
    if (this.inner.get) {
      return this.inner.get(key);
    }
    return null;
  }

  /**
   * Set passes through AND updates/removes cache accordingly.
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
    this.cache.delete(key);
    if (this.inner.set) {
      return this.inner.set(key, totalHits, expiresAt);
    }
    throw new Error('Inner store does not support set()');
  }

  /**
   * Threshold at which the shield starts caching blocked keys.
   * Used by {@link KeyManager} when invalidating with a separate `shield` reference.
   */
  getBlockOnConsumed(): number {
    return this.blockOnConsumed;
  }

  /**
   * Proactive sweep: remove all expired entries from the cache.
   * Called on a timer (sweepIntervalMs) and can be called manually.
   */
  sweep(): number {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
        this._totalKeysExpired++;
        this.onExpire?.(key);
        swept++;
      }
    }
    return swept;
  }

  /** Get current metrics snapshot */
  getMetrics(): ShieldMetrics {
    const total = this._storeCallsSaved + this._storeCalls;
    return {
      blockedKeyCount: this.cache.size,
      storeCallsSaved: this._storeCallsSaved,
      totalKeysBlocked: this._totalKeysBlocked,
      totalKeysExpired: this._totalKeysExpired,
      totalKeysEvicted: this._totalKeysEvicted,
      hitRate: total > 0 ? this._storeCallsSaved / total : 0,
      storeCalls: this._storeCalls,
    };
  }

  /** Reset metrics counters (not the cache) */
  resetMetrics(): void {
    this._storeCallsSaved = 0;
    this._storeCalls = 0;
    this._totalKeysBlocked = 0;
    this._totalKeysExpired = 0;
    this._totalKeysEvicted = 0;
  }

  /** Check if a specific key is currently shielded (blocked in memory) */
  isShielded(key: string): boolean {
    const entry = this.cache.get(key);
    return entry !== undefined && Date.now() < entry.expiresAt;
  }

  /** Get all currently shielded keys with their expiry info */
  getShieldedKeys(): Array<{ key: string; expiresAt: Date; totalHits: number }> {
    const now = Date.now();
    const keys: Array<{ key: string; expiresAt: Date; totalHits: number }> = [];
    for (const [key, entry] of this.cache) {
      if (now < entry.expiresAt) {
        keys.push({
          key,
          expiresAt: new Date(entry.expiresAt),
          totalHits: entry.cachedResult.totalHits,
        });
      }
    }
    return keys;
  }

  /** Manually remove a key from the shield cache (next request goes to store) */
  unshield(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Clear the entire shield cache */
  clearShield(): void {
    this.cache.clear();
  }

  /** Proxy getActiveKeys to inner store if supported */
  getActiveKeys(): Map<string, { totalHits: number; resetTime: Date }> {
    if (this.inner.getActiveKeys) {
      return this.inner.getActiveKeys();
    }
    return new Map();
  }

  /** Proxy resetAll to inner store if supported, and clear shield cache */
  resetAll(): void {
    this.cache.clear();
    this.inner.resetAll?.();
  }

  /** Shutdown: clear timers, clear cache, shutdown inner store */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.cache.clear();
    return this.inner.shutdown();
  }
}
