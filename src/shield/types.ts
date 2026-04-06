/**
 * Configuration for InMemoryShield — the in-memory block optimization layer.
 */
export interface InMemoryShieldOptions {
  /**
   * Block a key in memory when its totalHits reaches this threshold.
   * Once blocked in memory, subsequent increment() calls for this key
   * return immediately without touching the backing store.
   *
   * Typically set equal to `maxRequests` — block in memory as soon as
   * the key is rate-limited. Can be set lower to start caching earlier
   * (e.g. `maxRequests - 1` to avoid the final Redis call that confirms the block).
   *
   * Required. Must be >= 1.
   */
  blockOnConsumed: number;

  /**
   * How long to keep the in-memory block active, in milliseconds.
   * After this duration, the next request for the key goes back to the store
   * to check if the window has reset.
   *
   * Default: inferred from the store's window duration if available,
   * otherwise required. Setting this to 0 means "block for the remainder
   * of the current window" (calculated from the store's resetTime).
   *
   * If set explicitly, this overrides the window-based calculation.
   */
  blockDurationMs?: number;

  /**
   * Maximum number of keys to track in the in-memory block cache.
   * When this limit is reached, the oldest blocked key is evicted (LRU).
   * Prevents memory exhaustion under distributed attacks with many unique keys.
   *
   * Default: 10_000. Set to 0 for unlimited (not recommended in production).
   */
  maxBlockedKeys?: number;

  /**
   * How often to sweep expired entries from the block cache, in milliseconds.
   * The sweep is lazy by default (expired entries are cleaned on access),
   * but this interval triggers a proactive batch sweep.
   *
   * Default: 30_000 (30 seconds). Set to 0 to disable proactive sweeps
   * (rely on lazy expiry only — slightly lower memory overhead, slightly
   * higher worst-case memory usage).
   */
  sweepIntervalMs?: number;

  /**
   * Callback fired when a key is blocked in memory for the first time.
   * Useful for metrics and alerting.
   */
  onBlock?: (key: string, totalHits: number, expiresAt: Date) => void;

  /**
   * Callback fired when an in-memory block expires (either via lazy
   * access or proactive sweep). Useful for tracking block churn.
   */
  onExpire?: (key: string) => void;

  /**
   * Callback fired when a key is evicted from the block cache due to the
   * {@link maxBlockedKeys} limit being reached (LRU eviction). Unlike
   * {@link onExpire}, this fires because the cache is full — not because
   * the block window elapsed.
   */
  onEvict?: (key: string) => void;

  /**
   * Callback fired on every shielded (in-memory) rejection.
   * Called with the key and the cached result. Useful for counting
   * how many store calls were saved.
   */
  onShieldHit?: (key: string) => void;
}

/** Internal entry in the block cache */
export interface ShieldEntry {
  /** When this entry was created */
  blockedAt: number;     // Date.now() timestamp for perf (avoid Date objects)
  /** When this entry expires */
  expiresAt: number;     // Date.now() timestamp
  /** Cached increment result to return for shielded requests */
  cachedResult: {
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: true;     // always true — we only cache blocked results
  };
}

/** Metrics snapshot from the shield */
export interface ShieldMetrics {
  /** Number of keys currently blocked in memory */
  blockedKeyCount: number;
  /** Total number of store calls saved since creation */
  storeCallsSaved: number;
  /** Total number of keys that have been blocked since creation */
  totalKeysBlocked: number;
  /** Total number of keys whose block window elapsed (lazy or sweep expiry) */
  totalKeysExpired: number;
  /** Total number of keys evicted from the cache due to the {@link InMemoryShieldOptions.maxBlockedKeys} limit */
  totalKeysEvicted: number;
  /** Hit rate: storeCallsSaved / (storeCallsSaved + storeCalls) */
  hitRate: number;
  /** Total actual store calls (passed through the shield) */
  storeCalls: number;
}
