import { MemoryStore } from '../stores/memory-store.js';
import { RateLimitStrategy, type RateLimitStore } from '../types/index.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';
import { RateLimiterQueue } from './RateLimiterQueue.js';

export interface CreateRateLimiterQueueOptions {
  maxRequests: number;
  windowMs: number;
  strategy?: RateLimitStrategy;
  maxQueueSize?: number;
  maxQueueTimeMs?: number;
  /** When omitted, a {@link MemoryStore} is created from `strategy`, `windowMs`, and `maxRequests`. */
  store?: RateLimitStore;
}

function createDefaultMemoryStore(
  strategy: RateLimitStrategy,
  windowMs: number,
  maxRequests: number,
): MemoryStore {
  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return new MemoryStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      interval: windowMs,
      bucketSize: maxRequests,
      tokensPerInterval: maxRequests,
    });
  }
  return new MemoryStore({
    strategy,
    windowMs,
    maxRequests,
  });
}

/**
 * Creates a standalone {@link RateLimiterQueue} for non-HTTP use cases (outbound API throttling).
 * 
 * **Typical use case:** One queue per external API, using a single key for all requests to that API.
 * 
 * **Head-of-line blocking:** The queue is a single FIFO array. If you use multiple different keys
 * with the same queue, a blocked request for key "A" will cause requests for key "B" to wait, even
 * if "B" has capacity. For independent keys, create one queue per key instead.
 *
 * @example Single key (typical use case):
 * ```ts
 * // ✅ Good: one queue for one API
 * const githubQueue = createRateLimiterQueue({
 *   maxRequests: 30,
 *   windowMs: 60_000,
 *   maxQueueSize: 100,
 * });
 *
 * await githubQueue.removeTokens('github-api'); // All requests use same key
 * const data = await fetch('https://api.github.com/...');
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
 * @see {@link RateLimiterQueueOptions} for more details on head-of-line blocking
 */
export function createRateLimiterQueue(options: CreateRateLimiterQueueOptions): RateLimiterQueue {
  const strategy = options.strategy ?? RateLimitStrategy.SLIDING_WINDOW;
  const windowMs = sanitizeWindowMs(options.windowMs, 60_000);
  const maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);

  const store = options.store ?? createDefaultMemoryStore(strategy, windowMs, maxRequests);

  return new RateLimiterQueue(
    store,
    {
      windowMs,
      maxRequests,
      strategy,
    },
    {
      maxQueueSize: options.maxQueueSize,
      maxQueueTimeMs: options.maxQueueTimeMs,
    },
  );
}
