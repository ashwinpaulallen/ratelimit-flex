import { createRateLimiterQueue, type CreateRateLimiterQueueOptions } from './createRateLimiterQueue.js';
import { ShutdownError } from './errors.js';
import type { RateLimiterQueue, RateLimiterQueueResult } from './RateLimiterQueue.js';

/**
 * Options for {@link KeyedRateLimiterQueue}: same as {@link createRateLimiterQueue}, plus a hard cap on
 * how many distinct keys may have a dedicated {@link RateLimiterQueue} at once (LRU eviction).
 */
export interface KeyedRateLimiterQueueOptions extends CreateRateLimiterQueueOptions {
  /**
   * Maximum number of distinct **queue keys** (first argument to {@link KeyedRateLimiterQueue.forKey} /
   * {@link KeyedRateLimiterQueue.removeTokens}). When exceeded, the **least-recently-used** inner queue is
   * {@link RateLimiterQueue.shutdown | shut down} and removed before creating a new one.
   *
   * **`0` = unlimited** (no LRU eviction of inner queues), matching {@link MemoryStoreOptions.maxKeys}.
   * Negative values are clamped to `0` the same way as MemoryStore.
   *
   * @default 1000
   */
  maxKeys?: number;
}

/** @default 1000 when `raw` is `undefined` or non-finite. `0` = unlimited (no LRU eviction). */
function sanitizeKeyedPoolMaxKeys(raw: number | undefined): number {
  if (raw === undefined) {
    return 1000;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 1000;
  }
  const n = Math.max(0, Math.floor(raw));
  if (n === 0) {
    return 0;
  }
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

/**
 * Many independent {@link RateLimiterQueue} instances keyed by an application id (e.g. user or tenant),
 * with **LRU eviction** so memory stays bounded when the key set grows without bound.
 *
 * Each inner queue uses the same window / strategy / queue sizing options from {@link createRateLimiterQueue}.
 *
 * @example
 * ```ts
 * const keyed = new KeyedRateLimiterQueue({
 *   maxRequests: 10,
 *   windowMs: 60_000,
 *   maxKeys: 500,
 * });
 * await keyed.removeTokens('user:alice', 'user:alice');
 * await keyed.forKey('user:bob').removeTokens('user:bob');
 * ```
 */
export class KeyedRateLimiterQueue {
  private readonly base: CreateRateLimiterQueueOptions;

  private readonly maxKeys: number;

  private readonly map = new Map<string, RateLimiterQueue>();

  private isShutdown = false;

  constructor(options: KeyedRateLimiterQueueOptions) {
    const { maxKeys, ...base } = options;
    this.base = base;
    this.maxKeys = sanitizeKeyedPoolMaxKeys(maxKeys);
  }

  /**
   * Returns the {@link RateLimiterQueue} for `queueKey`, creating it or refreshing LRU order.
   * When at capacity, evicts the LRU queue and calls its {@link RateLimiterQueue.shutdown}.
   */
  forKey(queueKey: string): RateLimiterQueue {
    if (this.isShutdown) {
      throw new ShutdownError('queue-shutdown');
    }
    const existing = this.map.get(queueKey);
    if (existing !== undefined) {
      this.map.delete(queueKey);
      this.map.set(queueKey, existing);
      return existing;
    }

    while (this.maxKeys > 0 && this.map.size >= this.maxKeys) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      const q = this.map.get(oldest);
      this.map.delete(oldest);
      void q?.shutdown().catch(() => {
        /* ignore */
      });
    }

    const created = createRateLimiterQueue(this.base);
    this.map.set(queueKey, created);
    return created;
  }

  /** Convenience: `forKey(queueKey).removeTokens(rateLimitKey, cost)`. */
  removeTokens(queueKey: string, rateLimitKey: string, cost?: number): Promise<RateLimiterQueueResult> {
    if (this.isShutdown) {
      return Promise.reject(new ShutdownError('queue-shutdown'));
    }
    return this.forKey(queueKey).removeTokens(rateLimitKey, cost);
  }

  /** Current number of distinct keys with a live inner queue. */
  getKeyCount(): number {
    return this.map.size;
  }

  /** Max keys this pool was configured with (`0` = unlimited). */
  getMaxKeys(): number {
    return this.maxKeys;
  }

  /**
   * Shuts down every inner queue (each inner store is shut down only when that queue owns it —
   * same as {@link createRateLimiterQueue}).
   */
  async shutdown(options: { drainTimeoutMs?: number; reason?: string } = {}): Promise<{
    rejected: number;
    drained: number;
  }> {
    if (this.isShutdown) {
      return { rejected: 0, drained: 0 };
    }
    this.isShutdown = true;

    const queues = Array.from(this.map.values());
    this.map.clear();

    const results = await Promise.all(
      queues.map((q) =>
        q.shutdown(options).catch(() => ({
          rejected: 0,
          drained: 0,
        })),
      ),
    );

    return {
      rejected: results.reduce((sum, r) => sum + r.rejected, 0),
      drained: results.reduce((sum, r) => sum + r.drained, 0),
    };
  }
}
