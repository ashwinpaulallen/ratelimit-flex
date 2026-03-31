const DEFAULT_SAMPLE_CAPACITY = 1024;
const DEFAULT_HOT_KEY_MAX = 1000;

/**
 * Per-key request and blocked counts for one aggregation interval (see {@link MetricsCountersSnapshot.hotKeys}).
 *
 * @since 1.3.0
 */
export interface HotKeyIntervalCounts {
  /** Requests attributed to this key in the interval. */
  readonly hits: number;
  /** Blocked responses for this key in the interval (≤ {@link HotKeyIntervalCounts.hits}). */
  readonly blocked: number;
}

/**
 * Immutable view produced by {@link MetricsCounters.snapshot}.
 * Allocates only in snapshot(); hot-path methods do not allocate.
 */
export interface MetricsCountersSnapshot {
  readonly totalRequests: number;
  readonly allowedRequests: number;
  readonly blockedRequests: number;
  readonly blockedByRateLimit: number;
  readonly blockedByBlocklist: number;
  readonly blockedByPenalty: number;
  readonly blockedByServiceUnavailable: number;
  readonly skippedRequests: number;
  readonly allowlistedRequests: number;
  /** Drained request-path latency samples (ms), oldest first. */
  readonly latencySamplesMs: readonly number[];
  /** Drained store/Redis operation latency samples (ms), oldest first. */
  readonly storeLatencySamplesMs: readonly number[];
  /**
   * Hot keys for the period since the previous {@link snapshot} (then drained like latency rings).
   * `hits` is total requests per key; `blocked` is blocked responses for that key.
   */
  readonly hotKeys: ReadonlyMap<string, HotKeyIntervalCounts>;
}

export interface MetricsCountersOptions {
  /** Ring buffer capacity for latency and store latency (default 1024). */
  readonly sampleCapacity?: number;
  /** Max distinct keys tracked in the hot-key map (default 1000). */
  readonly hotKeyMaxEntries?: number;
}

/**
 * Lightweight, synchronous counters and samplers for the rate limiter hot path.
 *
 * **Zero-allocation hot path:** increments are plain number fields. Latency and store samples use
 * fixed {@link Float64Array} ring buffers (no `push` / growth). Hot-key tracking uses a bounded
 * {@link Map} with eviction of the lowest-count key when full. Allocations occur only in
 * {@link snapshot} (used by the background {@link MetricsCollector}), not during `consume` / middleware.
 *
 * @see {@link MetricsCounters.snapshot}
 */
export class MetricsCounters {
  totalRequests = 0;
  allowedRequests = 0;
  blockedRequests = 0;
  blockedByRateLimit = 0;
  blockedByBlocklist = 0;
  blockedByPenalty = 0;
  blockedByServiceUnavailable = 0;
  skippedRequests = 0;
  allowlistedRequests = 0;

  private readonly sampleCapacity: number;
  private readonly latencyBuffer: Float64Array;
  private readonly storeLatencyBuffer: Float64Array;
  private latencyWrite = 0;
  private latencyCount = 0;
  private storeWrite = 0;
  private storeCount = 0;

  private readonly hotKeyMax: number;
  /** Mutable entries — no per-call allocation after a key is tracked. */
  private readonly hotKeys: Map<string, { hits: number; blocked: number }>;

  constructor(options?: MetricsCountersOptions) {
    const cap = options?.sampleCapacity ?? DEFAULT_SAMPLE_CAPACITY;
    this.sampleCapacity = cap;
    this.latencyBuffer = new Float64Array(cap);
    this.storeLatencyBuffer = new Float64Array(cap);
    this.hotKeyMax = options?.hotKeyMaxEntries ?? DEFAULT_HOT_KEY_MAX;
    this.hotKeys = new Map();
  }

  recordLatency(startTime: number): void {
    const d = performance.now() - startTime;
    const buf = this.latencyBuffer;
    const cap = this.sampleCapacity;
    let w = this.latencyWrite;
    buf[w] = d;
    w++;
    if (w === cap) w = 0;
    this.latencyWrite = w;
    if (this.latencyCount < cap) this.latencyCount++;
  }

  recordStoreLatency(startTime: number): void {
    const d = performance.now() - startTime;
    const buf = this.storeLatencyBuffer;
    const cap = this.sampleCapacity;
    let w = this.storeWrite;
    buf[w] = d;
    w++;
    if (w === cap) w = 0;
    this.storeWrite = w;
    if (this.storeCount < cap) this.storeCount++;
  }

  recordKey(key: string): void {
    const map = this.hotKeys;
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.hits++;
      return;
    }
    if (map.size < this.hotKeyMax) {
      map.set(key, { hits: 1, blocked: 0 });
      return;
    }
    let minKey: string | undefined;
    let minVal = Number.POSITIVE_INFINITY;
    for (const [k, v] of map) {
      if (v.hits < minVal) {
        minVal = v.hits;
        minKey = k;
      }
    }
    if (minKey !== undefined) map.delete(minKey);
    map.set(key, { hits: 1, blocked: 0 });
  }

  /**
   * Increment blocked count for `key` for the current interval. Call once per blocked response, after
   * {@link recordKey} for the same request (engine order guarantees the key exists).
   */
  recordKeyBlocked(key: string): void {
    const e = this.hotKeys.get(key);
    if (e !== undefined) e.blocked++;
  }

  snapshot(): MetricsCountersSnapshot {
    const latencySamplesMs = this.drainRing(this.latencyBuffer, this.latencyWrite, this.latencyCount);
    this.latencyWrite = 0;
    this.latencyCount = 0;

    const storeLatencySamplesMs = this.drainRing(
      this.storeLatencyBuffer,
      this.storeWrite,
      this.storeCount,
    );
    this.storeWrite = 0;
    this.storeCount = 0;

    const hotKeysCopy = new Map<string, HotKeyIntervalCounts>();
    for (const [k, v] of this.hotKeys) {
      hotKeysCopy.set(k, { hits: v.hits, blocked: v.blocked });
    }
    this.hotKeys.clear();

    const snap: MetricsCountersSnapshot = {
      totalRequests: this.totalRequests,
      allowedRequests: this.allowedRequests,
      blockedRequests: this.blockedRequests,
      blockedByRateLimit: this.blockedByRateLimit,
      blockedByBlocklist: this.blockedByBlocklist,
      blockedByPenalty: this.blockedByPenalty,
      blockedByServiceUnavailable: this.blockedByServiceUnavailable,
      skippedRequests: this.skippedRequests,
      allowlistedRequests: this.allowlistedRequests,
      latencySamplesMs: Object.freeze(latencySamplesMs),
      storeLatencySamplesMs: Object.freeze(storeLatencySamplesMs),
      hotKeys: hotKeysCopy,
    };
    return Object.freeze(snap);
  }

  reset(): void {
    this.totalRequests = 0;
    this.allowedRequests = 0;
    this.blockedRequests = 0;
    this.blockedByRateLimit = 0;
    this.blockedByBlocklist = 0;
    this.blockedByPenalty = 0;
    this.blockedByServiceUnavailable = 0;
    this.skippedRequests = 0;
    this.allowlistedRequests = 0;
    this.latencyWrite = 0;
    this.latencyCount = 0;
    this.storeWrite = 0;
    this.storeCount = 0;
    this.hotKeys.clear();
  }

  private drainRing(buffer: Float64Array, write: number, count: number): number[] {
    const cap = this.sampleCapacity;
    if (count === 0) return [];
    const out = new Array<number>(count);
    if (count < cap) {
      for (let i = 0; i < count; i++) out[i] = buffer[i]!;
    } else {
      for (let i = 0; i < count; i++) out[i] = buffer[(write + i) % cap]!;
    }
    return out;
  }
}
