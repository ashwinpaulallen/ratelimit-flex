import type { RateLimitStore } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';

/**
 * Error code for {@link RateLimiterQueueError}.
 * 
 * @since 1.5.0
 */
export type RateLimiterQueueErrorCode = 'queue_full' | 'queue_timeout' | 'queue_shutdown' | 'queue_cleared' | 'cost_exceeds_limit';

/**
 * Error thrown by {@link RateLimiterQueue} operations.
 * 
 * @property code - Typed error code for robust error handling (no string matching needed)
 * @since 1.0.0
 */
export class RateLimiterQueueError extends Error {
  readonly code: RateLimiterQueueErrorCode;

  constructor(message: string, code: RateLimiterQueueErrorCode) {
    super(message);
    this.name = 'RateLimiterQueueError';
    this.code = code;
  }
}

/**
 * Options for {@link RateLimiterQueue}.
 * 
 * **IMPORTANT - Head-of-line blocking:** The queue is a single FIFO array. When a request for
 * key "A" is blocked (waiting for capacity), all subsequent requests for key "B" also wait,
 * even if "B" has available capacity. This is intentional for the outbound API throttler use
 * case (typically one key per queue, e.g., "github-api"), but may be surprising if you try to
 * queue requests across multiple independent keys.
 * 
 * **Solution for multiple keys:** Create one `RateLimiterQueue` per key instead of sharing a
 * single queue across different keys.
 * 
 * @example Single key (typical use case):
 * ```ts
 * // ✅ Good: one queue for one API
 * const githubQueue = createRateLimiterQueue({ maxRequests: 30, windowMs: 60_000 });
 * await githubQueue.removeTokens('github-api'); // All requests use same key
 * ```
 * 
 * @example Multiple independent keys (requires separate queues):
 * ```ts
 * // ❌ Bad: single queue with multiple keys causes head-of-line blocking
 * const sharedQueue = createRateLimiterQueue({ maxRequests: 10, windowMs: 1000 });
 * await sharedQueue.removeTokens('user:alice'); // Blocks...
 * await sharedQueue.removeTokens('user:bob');   // ...waits even if bob has capacity
 * 
 * // ✅ Good: separate queue per key
 * const queues = new Map<string, RateLimiterQueue>();
 * function getQueue(userId: string) {
 *   if (!queues.has(userId)) {
 *     queues.set(userId, createRateLimiterQueue({ maxRequests: 10, windowMs: 1000 }));
 *   }
 *   return queues.get(userId)!;
 * }
 * await getQueue('alice').removeTokens('user:alice'); // Independent
 * await getQueue('bob').removeTokens('user:bob');     // Independent
 * ```
 *
 * **See also:** Package README — **Request queuing** (diagram, multi-key misuse, LRU / unbounded `Map` note;
 * no built-in `KeyedRateLimiterQueue` in core).
 */
export interface RateLimiterQueueOptions {
  /** Maximum number of requests waiting in the queue. Default: Infinity */
  maxQueueSize?: number;

  /**
   * Maximum time in ms a request can wait in the queue before being rejected.
   * Default: Infinity (wait forever)
   */
  maxQueueTimeMs?: number;
}

export interface RateLimiterQueueResult {
  /** How many tokens remain after this consume */
  remaining: number;
  /** When the current window resets */
  resetTime: Date;
}

interface QueueEntry {
  key: string;
  cost: number;
  resolve: (result: RateLimiterQueueResult) => void;
  reject: (error: RateLimiterQueueError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RateLimiterQueue {
  private readonly store: RateLimitStore;

  private readonly maxQueueSize: number;

  private readonly maxQueueTimeMs: number;

  private queue: QueueEntry[] = [];

  private processing = false;

  private readonly keyPrefix: string | undefined;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  /** Mirrors the backing store strategy (drives how blocked increments are undone). */
  private readonly strategy: RateLimitStrategy;

  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private _shutdown = false;

  /**
   * Create a rate limiter queue.
   * 
   * **Store ownership:** The queue takes ownership of the provided store. Calling {@link shutdown}
   * will close the store via `store.shutdown()`. If you share a store across multiple queues or
   * components, use {@link clear} instead of {@link shutdown} to avoid closing the shared store
   * prematurely, and manage the store lifecycle separately.
   * 
   * **Head-of-line blocking:** The queue is a single FIFO array. When a request for key "A" is
   * blocked, all subsequent requests for key "B" also wait. This is intentional for the outbound
   * API throttler use case (typically one key per queue). If you need to queue requests across
   * multiple independent keys, create one `RateLimiterQueue` per key instead.
   * 
   * @param store - Backing rate limit store (MemoryStore, RedisStore, ClusterStore, etc.)
   * @param storeConfig - Window/bucket configuration and strategy
   * @param options - Queue size and timeout limits
   * 
   * @see {@link shutdown} for detailed examples of store ownership
   * @see {@link RateLimiterQueueOptions} for head-of-line blocking examples
   */
  constructor(
    store: RateLimitStore,
    storeConfig: {
      windowMs: number;
      maxRequests: number;
      keyPrefix?: string;
      /** @default {@link RateLimitStrategy.SLIDING_WINDOW} */
      strategy?: RateLimitStrategy;
    },
    options?: RateLimiterQueueOptions,
  ) {
    this.store = store;
    this.windowMs = storeConfig.windowMs;
    this.maxRequests = storeConfig.maxRequests;
    this.keyPrefix = storeConfig.keyPrefix;
    this.strategy = storeConfig.strategy ?? RateLimitStrategy.SLIDING_WINDOW;
    this.maxQueueSize = options?.maxQueueSize ?? Number.POSITIVE_INFINITY;
    this.maxQueueTimeMs = options?.maxQueueTimeMs ?? Number.POSITIVE_INFINITY;
  }

  /** `windowMs` from constructor (introspection / tests). */
  getWindowMs(): number {
    return this.windowMs;
  }

  /** Optional `keyPrefix` from constructor (for composite keys). */
  getKeyPrefix(): string | undefined {
    return this.keyPrefix;
  }

  /**
   * Acquire a token. Resolves when the request is allowed to proceed.
   * Rejects with RateLimiterQueueError if the queue is full or maxQueueTimeMs exceeded.
   * 
   * **Head-of-line blocking:** Requests are processed in FIFO order. If a request for key "A"
   * is blocked (waiting for capacity), subsequent requests for key "B" also wait, even if "B"
   * has capacity. For independent keys, create separate queues.
   *
   * @param key - The rate limit key (e.g. IP, API key, user ID)
   * @param cost - Number of tokens to consume (default: 1)
   * 
   * @see {@link RateLimiterQueueOptions} for head-of-line blocking examples
   */
  removeTokens(key: string, cost = 1): Promise<RateLimiterQueueResult> {
    if (this._shutdown) {
      return Promise.reject(new RateLimiterQueueError('Queue shut down', 'queue_shutdown'));
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new RateLimiterQueueError('Queue is full', 'queue_full'));
    }
    if (cost > this.maxRequests) {
      return Promise.reject(
        new RateLimiterQueueError('Requested tokens exceed maximum allowed per window', 'cost_exceeds_limit'),
      );
    }

    return new Promise<RateLimiterQueueResult>((resolve, reject) => {
      const entry: QueueEntry = {
        key,
        cost,
        resolve,
        reject,
        timer: null,
      };

      if (Number.isFinite(this.maxQueueTimeMs) && this.maxQueueTimeMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          entry.timer = null;
          entry.reject(new RateLimiterQueueError('Queue timeout exceeded', 'queue_timeout'));
          
          // If this was the head entry and drain is sleeping on drainTimer, restart drain immediately
          // instead of waiting for the full remaining drainTimer duration
          if (idx === 0 && this.drainTimer !== null) {
            this.clearDrainTimer();
            this.processing = false;
          }
          void this.drain();
        }, this.maxQueueTimeMs);
      }

      this.queue.push(entry);
      void this.drain();
    });
  }

  /** Returns the current number of items waiting in the queue */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Best-effort peek at remaining tokens without net consumption: `increment` then `decrement`
   * with `cost: 1`. Derives “remaining before the probe” as `result.remaining + 1` when not
   * blocked (the probe consumes one unit). Concurrent traffic can still interleave.
   */
  async getTokensRemaining(key: string): Promise<number> {
    const result = await this.store.increment(key, { maxRequests: this.maxRequests, cost: 1 });
    await this.store.decrement(key, { cost: 1 });
    if (result.isBlocked) {
      return 0;
    }
    return result.remaining + 1;
  }

  /**
   * Cancel all queued requests (rejects them with RateLimiterQueueError).
   * 
   * Unlike {@link shutdown}, this does **not** close the backing store, making it safe to use
   * when the store is shared across multiple queues or components.
   * 
   * @see {@link shutdown} for store lifecycle management
   */
  clear(): void {
    this.clearPending(new RateLimiterQueueError('Queue cleared', 'queue_cleared'));
  }

  /**
   * Graceful shutdown: reject all pending, clean up timers, and **close the backing store**.
   * 
   * **IMPORTANT:** This calls `store.shutdown()`, which closes the backing store. If you passed
   * a custom store that is shared with other components (e.g., a shared `RedisStore` or `ClusterStore`),
   * calling `shutdown()` will close that store for all consumers. If you need to share a store,
   * either:
   * - Call `queue.clear()` instead of `queue.shutdown()` to reject pending requests without closing the store, OR
   * - Manage store lifecycle separately and only call `store.shutdown()` when all consumers are done.
   * 
   * @example
   * ```ts
   * // Safe: each queue has its own store
   * const queue = createRateLimiterQueue({ maxRequests: 10, windowMs: 60_000 });
   * await queue.shutdown(); // ✅ closes the internal MemoryStore
   * 
   * // Unsafe: shared store
   * const sharedStore = new RedisStore({ client: redisClient });
   * const queue1 = new RateLimiterQueue(sharedStore, { ... });
   * const queue2 = new RateLimiterQueue(sharedStore, { ... });
   * await queue1.shutdown(); // ❌ closes sharedStore, breaking queue2
   * 
   * // Safe alternative:
   * queue1.clear(); // ✅ only clears queue1's pending requests
   * queue2.clear(); // ✅ only clears queue2's pending requests
   * await sharedStore.shutdown(); // ✅ close store after all queues are done
   * ```
   */
  shutdown(): void {
    this._shutdown = true;
    this.clearPending(new RateLimiterQueueError('Queue shut down', 'queue_shutdown'));
    void this.store.shutdown();
  }

  private clearPending(err: RateLimiterQueueError): void {
    this.clearDrainTimer();
    for (const e of this.queue) {
      if (e.timer !== null) {
        clearTimeout(e.timer);
        e.timer = null;
      }
      e.reject(err);
    }
    this.queue = [];
    this.processing = false;
  }

  private clearDrainTimer(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /**
   * Undo an increment: sliding window uses LIFO so we drop the probe just added, not older legitimate hits.
   * Token bucket: blocked increments do not consume tokens, so no decrement (regardless of kind).
   * 
   * @param key - Rate limit key
   * @param cost - Token cost to undo
   * @param _kind - 'blocked' or 'stale-head' (unused but kept for clarity at call sites)
   * @param isBlocked - Whether the increment was blocked (from result.isBlocked)
   */
  private async undoIncrementAfterFailedOrStaleHead(
    key: string,
    cost: number,
    _kind: 'blocked' | 'stale-head',
    isBlocked: boolean,
  ): Promise<void> {
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET && isBlocked) {
      // Blocked bucket increments don't consume tokens — nothing to undo
      return;
    }
    if (this.strategy === RateLimitStrategy.SLIDING_WINDOW) {
      await this.store.decrement(key, { cost, removeNewest: true });
      return;
    }
    await this.store.decrement(key, { cost });
  }

  private async drain(): Promise<void> {
    if (this._shutdown || this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0]!;
        const result = await this.store.increment(entry.key, {
          maxRequests: this.maxRequests,
          cost: entry.cost,
        });

        if (this.queue[0] !== entry) {
          await this.undoIncrementAfterFailedOrStaleHead(entry.key, entry.cost, 'stale-head', result.isBlocked);
          continue;
        }

        if (!result.isBlocked) {
          this.queue.shift();
          if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          entry.resolve({
            remaining: result.remaining,
            resetTime: result.resetTime,
          });
          continue;
        }

        await this.undoIncrementAfterFailedOrStaleHead(entry.key, entry.cost, 'blocked', true);

        const delay = Math.max(10, result.resetTime.getTime() - Date.now());
        this.clearDrainTimer();
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          this.processing = false;
          void this.drain();
        }, delay);
        return;
      }
    } finally {
      if (this.drainTimer === null) {
        this.processing = false;
      }
    }
  }
}
