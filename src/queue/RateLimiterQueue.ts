import type { RateLimitStore } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { ShutdownError } from './errors.js';

/**
 * Minimum delay (ms) before retrying the internal drain loop when the queue head is blocked
 * (avoids tight spin). Reused as the polling step in {@link RateLimiterQueue.shutdown}.
 */
const MIN_BLOCK_RETRY_DELAY_MS = 10;

/**
 * Error code for {@link RateLimiterQueueError}.
 *
 * @since 1.5.0
 */
export type RateLimiterQueueErrorCode =
  | 'queue_full'
  | 'queue_timeout'
  | 'queue_shutdown'
  | 'queue_cleared'
  | 'cost_exceeds_limit'
  | 'invalid_cost';

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
 * **IMPORTANT - Head-of-line blocking:** The queue is a single FIFO list. When a request for
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
 * **See also:** Package README — **Request queuing** (diagram, multi-key misuse). For bounded LRU pools of
 * queues, use {@link KeyedRateLimiterQueue}.
 */
export interface RateLimiterQueueOptions {
  /** Maximum number of requests waiting in the queue. Default: Infinity */
  maxQueueSize?: number;

  /**
   * Maximum time in ms a request can wait in the queue before being rejected.
   * Default: Infinity (wait forever)
   */
  maxQueueTimeMs?: number;

  /**
   * When **`true`**, {@link shutdown} awaits `store.shutdown()` after clearing the queue.
   * Set by {@link createRateLimiterQueue} when it creates the default {@link MemoryStore}.
   * When **`false`** (default), the caller owns the store — use for middleware and shared stores.
   *
   * @default false
   * @since 4.0.0
   */
  ownsStore?: boolean;
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
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Intrusive doubly-linked list (FIFO). O(1) unlink on queue timeout vs array indexOf/splice. */
  prev: QueueEntry | null;
  next: QueueEntry | null;
}

export class RateLimiterQueue {
  private readonly store: RateLimitStore;

  private readonly maxQueueSize: number;

  private readonly maxQueueTimeMs: number;

  private queueHead: QueueEntry | null = null;

  private queueTail: QueueEntry | null = null;

  private queueLength = 0;

  private processing = false;

  private readonly keyPrefix: string | undefined;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  /** Mirrors the backing store strategy (drives how blocked increments are undone). */
  private readonly strategy: RateLimitStrategy;

  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private isShutdown = false;

  /**
   * Count of queue entries removed by the max-queue-time timer during shutdown (excluded from
   * {@link shutdown} `drained`). Reset after drain accounting and on redundant {@link shutdown} calls.
   */
  private shutdownQueueTimeoutUnlinks = 0;

  private readonly ownsStore: boolean;

  /**
   * Create a rate limiter queue.
   *
   * **Store ownership:** Pass **`ownsStore: true`** in `options` only when this queue created the
   * store (see {@link createRateLimiterQueue}). Otherwise {@link shutdown} does not call
   * `store.shutdown()` — use {@link clear} to drop pending work without touching a shared store.
   *
   * **Head-of-line blocking:** The queue is a single FIFO list. When a request for key "A" is
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
    this.ownsStore = options?.ownsStore ?? false;
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
   * **After {@link shutdown} has started:** rejects immediately with {@link ShutdownError}; waiters
   * already in the queue are handled as described in {@link shutdown}.
   *
   * @param key - The rate limit key (e.g. IP, API key, user ID)
   * @param cost - Number of tokens to consume (default: 1)
   *
   * @see {@link RateLimiterQueueOptions} for head-of-line blocking examples
   */
  removeTokens(key: string, cost = 1): Promise<RateLimiterQueueResult> {
    if (this.isShutdown) {
      return Promise.reject(new ShutdownError('queue-shutdown'));
    }
    if (this.queueLength >= this.maxQueueSize) {
      return Promise.reject(new RateLimiterQueueError('Queue is full', 'queue_full'));
    }
    if (!Number.isFinite(cost) || cost < 1) {
      return Promise.reject(
        new RateLimiterQueueError('cost must be a finite number >= 1', 'invalid_cost'),
      );
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
        prev: null,
        next: null,
      };

      if (Number.isFinite(this.maxQueueTimeMs) && this.maxQueueTimeMs > 0) {
        entry.timer = setTimeout(() => {
          const wasHead = entry === this.queueHead;
          const removed = this.unlink(entry);
          entry.timer = null;
          if (removed) {
            if (this.isShutdown) {
              this.shutdownQueueTimeoutUnlinks++;
            }
            entry.reject(new RateLimiterQueueError('Queue timeout exceeded', 'queue_timeout'));
            if (wasHead && this.drainTimer !== null) {
              this.clearDrainTimer();
              this.processing = false;
            }
            void this.drain();
          }
        }, this.maxQueueTimeMs);
      }

      this.enqueueTail(entry);
      void this.drain();
    });
  }

  /** Returns the current number of items waiting in the queue */
  getQueueSize(): number {
    return this.queueLength;
  }

  /**
   * @internal FIFO snapshot of queued entries for tests (e.g. fake timers + timer manipulation).
   * Not a stable public API surface.
   */
  getQueueEntriesForTests(): Array<{ timer: ReturnType<typeof setTimeout> | null }> {
    const out: Array<{ timer: ReturnType<typeof setTimeout> | null }> = [];
    for (let e = this.queueHead; e !== null; e = e.next) {
      out.push(e);
    }
    return out;
  }

  /**
   * Best-effort peek at remaining tokens without net consumption: `increment` then `decrement`
   * with `cost: 1`. Derives “remaining before the probe” as `result.remaining + 1` when not
   * blocked (the probe consumes one unit). Concurrent traffic can still interleave.
   */
  async getTokensRemaining(key: string): Promise<number> {
    if (this.isShutdown) {
      throw new ShutdownError('queue-shutdown');
    }
    const result = await this.store.increment(key, { maxRequests: this.maxRequests, cost: 1 });
    try {
      await this.store.decrement(key, { cost: 1 });
    } catch (err) {
      await this.undoIncrementAfterFailedOrStaleHead(key, 1, 'stale-head', result.isBlocked).catch(() => {
        /* ignore */
      });
      throw err;
    }
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
    if (this.isShutdown) {
      throw new ShutdownError('queue-shutdown');
    }
    this.clearPending(new RateLimiterQueueError('Queue cleared', 'queue_cleared'));
  }

  /**
   * Gracefully shut down the queue. Once shutdown begins, {@link removeTokens} rejects **new**
   * requests immediately with {@link ShutdownError} (including while this method is still
   * awaiting the drain window)—incoming work is turned away while the queue drains. Waiters
   * **already enqueued** keep being processed by the internal drain loop and may still **resolve
   * successfully** during the **`drainTimeoutMs`** grace period (best-effort). When that window ends,
   * any waiters still in the FIFO are rejected with {@link ShutdownError} so callers can handle
   * them (e.g. **503** in HTTP middleware). After {@link shutdown} returns, {@link removeTokens}
   * continues to reject immediately for the lifetime of this instance.
   *
   * **Idempotent** — safe to call from multiple signal handlers.
   *
   * **`drainTimeoutMs`** is best-effort: this implementation polls every **`MIN_BLOCK_RETRY_DELAY_MS`**
   *   (same as the minimum drain block-retry delay) until the deadline.
   * Slow handlers may still leave work in the queue; remaining entries are then rejected. Do not
   * assume a full drain just because the timeout is large.
   *
   * **`ownsStore`:** When **`true`** (see {@link createRateLimiterQueue}), `store.shutdown()` is
   * awaited after pending work is cleared. When **`false`**, the store is left open.
   *
   * @param options.drainTimeoutMs — Wait up to this many ms for entries to complete via the normal
   *   drain path before rejecting the rest. **Default: 0** (reject queued waiters immediately).
   * @param options.reason — Passed to {@link ShutdownError} for each rejected waiter.
   *
   * @returns **`rejected`** — waiters still queued when the drain window ends, rejected with
   *   {@link ShutdownError}. **`drained`** — entries that acquired capacity via the normal
   *   {@link drain} path during shutdown; entries that leave due to {@link RateLimiterQueueOptions.maxQueueTimeMs}
   *   (`queue_timeout`) are not included.
   */
  async shutdown(options: { drainTimeoutMs?: number; reason?: string } = {}): Promise<{
    rejected: number;
    drained: number;
  }> {
    if (this.isShutdown) {
      this.shutdownQueueTimeoutUnlinks = 0;
      return { rejected: 0, drained: 0 };
    }
    this.shutdownQueueTimeoutUnlinks = 0;
    this.isShutdown = true;

    const reason = options.reason ?? 'shutdown';
    const drainTimeoutMs = options.drainTimeoutMs ?? 0;
    const err = new ShutdownError(reason);

    const lenAtStart = this.queueLength;
    void this.drain();

    if (drainTimeoutMs > 0 && this.queueLength > 0) {
      const maxPolls = Math.max(1, Math.ceil(drainTimeoutMs / MIN_BLOCK_RETRY_DELAY_MS));
      for (let i = 0; i < maxPolls && this.queueLength > 0; i++) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, MIN_BLOCK_RETRY_DELAY_MS);
        });
        void this.drain();
      }
    }

    const drained = Math.max(0, lenAtStart - this.queueLength - this.shutdownQueueTimeoutUnlinks);
    const rejected = this.queueLength;
    this.clearPending(err);
    this.shutdownQueueTimeoutUnlinks = 0;

    if (this.ownsStore) {
      await this.store.shutdown();
    }

    return { rejected, drained };
  }

  private enqueueTail(entry: QueueEntry): void {
    entry.prev = this.queueTail;
    entry.next = null;
    if (this.queueTail !== null) {
      this.queueTail.next = entry;
    } else {
      this.queueHead = entry;
    }
    this.queueTail = entry;
    this.queueLength++;
  }

  /**
   * Remove `entry` from the FIFO list. Returns false if `entry` was not in the list (already removed).
   */
  private unlink(entry: QueueEntry): boolean {
    if (this.queueHead !== entry && entry.prev === null && entry.next === null) {
      return false;
    }
    if (entry.prev !== null) {
      entry.prev.next = entry.next;
    } else {
      this.queueHead = entry.next;
    }
    if (entry.next !== null) {
      entry.next.prev = entry.prev;
    } else {
      this.queueTail = entry.prev;
    }
    entry.prev = null;
    entry.next = null;
    this.queueLength--;
    return true;
  }

  private clearPending(err: Error): void {
    this.clearDrainTimer();
    let e = this.queueHead;
    while (e !== null) {
      const next = e.next;
      if (e.timer !== null) {
        clearTimeout(e.timer);
        e.timer = null;
      }
      e.reject(err);
      e.prev = null;
      e.next = null;
      e = next;
    }
    this.queueHead = null;
    this.queueTail = null;
    this.queueLength = 0;
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
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.queueHead !== null) {
        const entry = this.queueHead;
        const result = await this.store.increment(entry.key, {
          maxRequests: this.maxRequests,
          cost: entry.cost,
        });

        if (this.queueHead !== entry) {
          await this.undoIncrementAfterFailedOrStaleHead(entry.key, entry.cost, 'stale-head', result.isBlocked);
          continue;
        }

        if (!result.isBlocked) {
          this.unlink(entry);
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

        const delay = Math.max(MIN_BLOCK_RETRY_DELAY_MS, result.resetTime.getTime() - Date.now());
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
