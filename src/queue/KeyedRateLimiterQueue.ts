import { createRateLimiterQueue, type CreateRateLimiterQueueOptions } from './createRateLimiterQueue.js';
import type { RateLimiterQueue, RateLimiterQueueResult } from './RateLimiterQueue.js';
import { sanitizeRateLimitCap } from '../utils/clamp.js';

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
   * @default 1000
   */
  maxKeys?: number;
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

  constructor(options: KeyedRateLimiterQueueOptions) {
    const { maxKeys, ...base } = options;
    this.base = base;
    this.maxKeys = sanitizeRateLimitCap(maxKeys ?? 1000, 1000);
  }

  /**
   * Returns the {@link RateLimiterQueue} for `queueKey`, creating it or refreshing LRU order.
   * When at capacity, evicts the LRU queue and calls its {@link RateLimiterQueue.shutdown}.
   */
  forKey(queueKey: string): RateLimiterQueue {
    const existing = this.map.get(queueKey);
    if (existing !== undefined) {
      this.map.delete(queueKey);
      this.map.set(queueKey, existing);
      return existing;
    }

    while (this.map.size >= this.maxKeys) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      const q = this.map.get(oldest);
      this.map.delete(oldest);
      q?.shutdown();
    }

    const created = createRateLimiterQueue(this.base);
    this.map.set(queueKey, created);
    return created;
  }

  /** Convenience: `forKey(queueKey).removeTokens(rateLimitKey, cost)`. */
  removeTokens(queueKey: string, rateLimitKey: string, cost?: number): Promise<RateLimiterQueueResult> {
    return this.forKey(queueKey).removeTokens(rateLimitKey, cost);
  }

  /** Current number of distinct keys with a live inner queue. */
  getKeyCount(): number {
    return this.map.size;
  }

  /** Max keys this pool was configured with. */
  getMaxKeys(): number {
    return this.maxKeys;
  }

  /**
   * Shuts down every inner queue (and each backing store created by {@link createRateLimiterQueue}).
   */
  shutdown(): void {
    for (const q of this.map.values()) {
      q.shutdown();
    }
    this.map.clear();
  }
}
