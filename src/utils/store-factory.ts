import { MemoryStore } from '../stores/memory-store.js';
import { RedisStore, type RedisLikeClient, type RedisErrorMode } from '../stores/redis-store.js';
import { RateLimitStrategy, type RateLimitStore } from '../types/index.js';

/**
 * Redis connection options for {@link createStore} when `type` is `'redis'`.
 *
 * @description Pass **either** `client` **or** `url`, not both (same rule as {@link RedisStore}).
 * @since 1.2.0
 */
export type RedisStoreConnectionOptions =
  | {
      /**
       * @description Pre-connected {@link RedisLikeClient}.
       */
      client: RedisLikeClient;
      /** @description Disallow `url` on this branch. */
      url?: never;
      /**
       * @description Redis key prefix for this store.
       * @default `"rlf:"` (inside {@link RedisStore})
       */
      prefix?: string;
      /**
       * @description Redis failure policy for increments.
       * @default `'fail-open'` inside {@link RedisStore} when omitted
       */
      onRedisError?: RedisErrorMode;
    }
  | {
      /**
       * @description Redis URL; requires optional peer `ioredis` at runtime.
       */
      url: string;
      /** @description Disallow `client` on this branch. */
      client?: never;
      /**
       * @description Redis key prefix for this store.
       * @default `"rlf:"`
       */
      prefix?: string;
      /**
       * @description Redis failure policy for increments.
       * @default `'fail-open'`
       */
      onRedisError?: RedisErrorMode;
    };

/**
 * Discriminated union for {@link createStore}.
 *
 * @description
 * - `memory` + window strategy: optional `windowMs` / `maxRequests`.
 * - `memory` + token bucket: required `tokensPerInterval`, `interval`, `bucketSize`.
 * - `redis` + window or bucket: requires `redis` connection options.
 * @see {@link RedisStoreConnectionOptions}
 * @since 1.2.0
 */
export type CreateStoreOptions =
  | {
      /** @description Use in-process {@link MemoryStore}. */
      type: 'memory';
      /** @description Sliding or fixed window. */
      strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
      /**
       * @description Window length in milliseconds.
       * @default 60000
       */
      windowMs?: number;
      /**
       * @description Max requests per window.
       * @default 100
       */
      maxRequests?: number;
    }
  | {
      /** @description Use in-process {@link MemoryStore}. */
      type: 'memory';
      /** @description Token bucket strategy. */
      strategy: RateLimitStrategy.TOKEN_BUCKET;
      /**
       * @description Tokens added per refill `interval`.
       */
      tokensPerInterval: number;
      /**
       * @description Refill interval in milliseconds.
       */
      interval: number;
      /**
       * @description Burst capacity.
       */
      bucketSize: number;
    }
  | {
      /** @description Use {@link RedisStore}. */
      type: 'redis';
      /** @description Sliding or fixed window. */
      strategy: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
      /**
       * @description Window length in milliseconds.
       * @default 60000
       */
      windowMs?: number;
      /**
       * @description Max requests per window.
       * @default 100
       */
      maxRequests?: number;
      /** @description Connection and Redis options. */
      redis: RedisStoreConnectionOptions;
    }
  | {
      /** @description Use {@link RedisStore}. */
      type: 'redis';
      /** @description Token bucket strategy. */
      strategy: RateLimitStrategy.TOKEN_BUCKET;
      /** @description Tokens per interval. */
      tokensPerInterval: number;
      /** @description Refill interval in milliseconds. */
      interval: number;
      /** @description Burst capacity. */
      bucketSize: number;
      /** @description Connection and Redis options. */
      redis: RedisStoreConnectionOptions;
    };

function assertRedisConnection(redis: RedisStoreConnectionOptions): void {
  const hasClient = redis.client !== undefined;
  const hasUrl = redis.url !== undefined && redis.url !== '';
  if (hasClient && hasUrl) {
    throw new Error('createStore: pass either redis.client or redis.url, not both');
  }
  if (!hasClient && !hasUrl) {
    throw new Error('createStore: redis type requires either redis.client or redis.url');
  }
}

/**
 * Factory that returns a {@link MemoryStore} or {@link RedisStore} from a single options object.
 *
 * @param options - Discriminated by `type` and `strategy` (see {@link CreateStoreOptions}).
 * @returns A {@link RateLimitStore} instance ready for {@link RateLimitEngine} or middleware.
 * @example
 * ```ts
 * const store = createStore({
 *   type: 'redis',
 *   strategy: RateLimitStrategy.SLIDING_WINDOW,
 *   windowMs: 60_000,
 *   maxRequests: 100,
 *   redis: { url: 'redis://localhost:6379' },
 * });
 * ```
 * @throws {Error} When Redis options include both `client` and `url`, or neither; or when `type` is invalid at runtime.
 * @see {@link MemoryStore}
 * @see {@link RedisStore}
 * @since 1.2.0
 */
export function createStore(options: CreateStoreOptions): RateLimitStore {
  const { type } = options;
  if (type === 'memory') {
    if (options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: options.tokensPerInterval,
        interval: options.interval,
        bucketSize: options.bucketSize,
      });
    }
    return new MemoryStore({
      strategy: options.strategy,
      windowMs: options.windowMs ?? 60_000,
      maxRequests: options.maxRequests ?? 100,
    });
  }

  if (type === 'redis') {
    assertRedisConnection(options.redis);
    const { redis } = options;
    if (options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return new RedisStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: options.tokensPerInterval,
        interval: options.interval,
        bucketSize: options.bucketSize,
        client: redis.client,
        url: redis.url,
        keyPrefix: redis.prefix,
        onRedisError: redis.onRedisError,
      });
    }
    return new RedisStore({
      strategy: options.strategy,
      windowMs: options.windowMs ?? 60_000,
      maxRequests: options.maxRequests ?? 100,
      client: redis.client,
      url: redis.url,
      keyPrefix: redis.prefix,
      onRedisError: redis.onRedisError,
    });
  }

  throw new Error(`createStore: unknown store type "${String(type)}"`);
}
