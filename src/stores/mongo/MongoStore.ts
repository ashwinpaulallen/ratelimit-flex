import type { Collection, Document, MongoClient } from 'mongodb';

import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../../types/index.js';
import { RateLimitStrategy } from '../../types/index.js';
import {
  sanitizeIncrementCost,
  sanitizeRateLimitCap,
  sanitizeWindowMs,
} from '../../utils/clamp.js';
import { num, refillBucketState, resetTimeDateFromSlidingStamps } from '../../utils/store-utils.js';
import type { MongoStoreClient, MongoStoreOptions, RateLimitDocument } from './types.js';

const DEFAULT_COLLECTION = 'rate_limits';

function parseHitsArray(hits: unknown): number[] {
  if (!Array.isArray(hits)) {
    return [];
  }
  const out: number[] = [];
  for (const x of hits) {
    const n = num(x);
    if (Number.isFinite(n)) {
      out.push(n);
    }
  }
  return out;
}

/** Oldest hit + window length from raw BSON `hits` (parses once). */
function resetTimeFromSlidingHits(hits: unknown, windowMs: number, nowMs: number): Date {
  return resetTimeDateFromSlidingStamps(parseHitsArray(hits), windowMs, nowMs);
}

/**
 * MongoDB-backed {@link RateLimitStore} using a single atomic
 * {@link Collection.findOneAndUpdate} with an aggregation pipeline per increment
 * (MongoDB 4.2+), matching Postgres `CASE` / upsert semantics without races.
 *
 * @since 3.3.0
 */
export class MongoStore implements RateLimitStore {
  private readonly collection: Collection<RateLimitDocument>;

  private readonly strategy: RateLimitStrategy;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  private readonly tokensPerInterval: number;

  private readonly refillIntervalMs: number;

  private readonly bucketSize: number;

  private readonly keyPrefix: string;

  private readonly onMongoError: 'fail-open' | 'fail-closed';

  private readonly onWarn: (msg: string, err?: Error) => void;

  private indexesEnsured: Promise<void> | null = null;

  constructor(options: MongoStoreOptions) {
    this.collection = MongoStore.resolveCollection(options.mongo);
    this.strategy = options.strategy ?? RateLimitStrategy.SLIDING_WINDOW;
    this.windowMs = sanitizeWindowMs(options.windowMs, 60_000);
    this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
    this.tokensPerInterval = Math.max(1, Math.floor(options.tokensPerInterval ?? 10));
    this.refillIntervalMs = sanitizeWindowMs(options.interval, 60_000);
    this.bucketSize = sanitizeRateLimitCap(options.bucketSize, 100);
    this.keyPrefix = options.keyPrefix ?? 'rlf:';
    this.onMongoError = options.onMongoError ?? 'fail-open';
    this.onWarn = options.onWarn ?? ((msg, err) => console.warn(`[ratelimit-flex] ${msg}`, err ?? ''));

    if (options.ensureIndexes !== false) {
      this.indexesEnsured = this.ensureIndexes().finally(() => {
        this.indexesEnsured = null;
      });
    }
  }

  private static resolveCollection(mongo: MongoStoreClient): Collection<RateLimitDocument> {
    if ('collection' in mongo) {
      return mongo.collection as unknown as Collection<RateLimitDocument>;
    }
    const name = mongo.collectionName ?? DEFAULT_COLLECTION;
    if ('db' in mongo) {
      return mongo.db.collection<RateLimitDocument>(name);
    }
    const client: MongoClient = mongo.client;
    const db = mongo.dbName !== undefined ? client.db(mongo.dbName) : client.db();
    return db.collection<RateLimitDocument>(name);
  }

  private async ensureIndexes(): Promise<void> {
    try {
      await this.collection.createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 });
    } catch (err) {
      this.onWarn('MongoStore ensureIndexes failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    if (this.indexesEnsured) {
      await this.indexesEnsured;
    }

    const prefixedKey = this.keyPrefix + key;
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const maxRequests =
      this.strategy === RateLimitStrategy.TOKEN_BUCKET
        ? this.bucketSize
        : sanitizeRateLimitCap(options?.maxRequests ?? this.maxRequests, this.maxRequests);

    try {
      switch (this.strategy) {
        case RateLimitStrategy.FIXED_WINDOW:
          return await this.incrementFixedWindow(prefixedKey, cost, maxRequests);
        case RateLimitStrategy.TOKEN_BUCKET:
          return await this.incrementTokenBucket(prefixedKey, cost);
        case RateLimitStrategy.SLIDING_WINDOW:
          return await this.incrementSlidingWindow(prefixedKey, cost, maxRequests);
        default: {
          const _: never = this.strategy;
          throw new Error(`MongoStore: unknown strategy ${String(_)}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('MongoStore:')) {
        throw err;
      }
      return this.handleError(err instanceof Error ? err : new Error(String(err)), maxRequests);
    }
  }

  /**
   * Fixed window using aggregation pipeline in findOneAndUpdate.
   *
   * If resetAt <= now (or missing), set totalHits = cost and resetAt = now + windowMs;
   * else increment totalHits by cost and keep resetAt.
   */
  private async incrementFixedWindow(
    key: string,
    cost: number,
    maxRequests: number,
  ): Promise<RateLimitResult> {
    const now = new Date();
    const nextResetAt = new Date(now.getTime() + this.windowMs);

    const pipeline: Document[] = [
      {
        $set: {
          totalHits: {
            $cond: {
              if: {
                $lte: [{ $ifNull: ['$resetAt', new Date(0)] }, now],
              },
              then: cost,
              else: { $add: [{ $ifNull: ['$totalHits', 0] }, cost] },
            },
          },
          resetAt: {
            $cond: {
              if: {
                $lte: [{ $ifNull: ['$resetAt', new Date(0)] }, now],
              },
              then: nextResetAt,
              else: { $ifNull: ['$resetAt', nextResetAt] },
            },
          },
        },
      },
    ];

    const doc = await this.collection.findOneAndUpdate({ _id: key }, pipeline, {
      upsert: true,
      returnDocument: 'after',
    });

    if (!doc) {
      throw new Error('MongoStore: fixed window increment returned no document');
    }

    const totalHits = Math.round(Number(doc.totalHits));
    const resetTime = doc.resetAt instanceof Date ? doc.resetAt : new Date(doc.resetAt ?? nextResetAt);

    return {
      totalHits,
      remaining: Math.max(0, maxRequests - totalHits),
      resetTime,
      isBlocked: totalHits > maxRequests,
    };
  }

  /**
   * Token bucket: refill + deduct in one pipeline (multi-stage so fields can depend on prior stages).
   *
   * **Transient `rlfTbBlocked` and two writes:** the pipeline sets `rlfTbBlocked` so we can read
   * `isBlocked` from the `findOneAndUpdate` result. A follow-up `updateOne` `$unset`s it so it is
   * not stored as stale state. Including `rlfTbBlocked` in the same pipeline’s final `$unset` would
   * remove it from the returned document (MongoDB returns the post-pipeline document), so we cannot
   * read the flag and strip it in a single round-trip without a second write.
   *
   * **Trade-off:** each token-bucket increment does **two** MongoDB writes on the hot path. For
   * very high-throughput token-bucket workloads, that extra write is a deliberate cost in exchange
   * for correct `isBlocked` without persisting a boolean. Deriving `isBlocked` from `tokens` /
   * `totalHits` alone is not reliable (e.g. `cost > 1`, full-bucket display, and indistinguishable
   * post-update rows) without the pipeline’s `_refilled < cost` check.
   */
  private async incrementTokenBucket(key: string, cost: number): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const bs = this.bucketSize;
    const tpi = this.tokensPerInterval;
    const interval = this.refillIntervalMs;

    const pipeline: Document[] = [
      { $set: { _lastMs: { $toLong: { $ifNull: ['$lastRefillAt', now] } } } },
      {
        $set: {
          _ints: {
            $floor: { $divide: [{ $subtract: [nowMs, '$_lastMs'] }, interval] },
          },
        },
      },
      {
        $set: {
          _refilled: {
            $min: [
              bs,
              {
                $add: [{ $ifNull: ['$tokens', bs] }, { $multiply: ['$_ints', tpi] }],
              },
            ],
          },
          _lastRf: { $add: ['$_lastMs', { $multiply: ['$_ints', interval] }] },
        },
      },
      {
        $set: {
          tokens: {
            $cond: {
              if: { $gte: ['$_refilled', cost] },
              then: { $subtract: ['$_refilled', cost] },
              else: '$_refilled',
            },
          },
          lastRefillAt: { $toDate: '$_lastRf' },
          totalHits: {
            $cond: {
              if: { $gte: ['$_refilled', cost] },
              then: { $subtract: [bs, { $subtract: ['$_refilled', cost] }] },
              else: bs,
            },
          },
          resetAt: { $toDate: { $add: ['$_lastRf', interval] } },
          rlfTbBlocked: { $lt: ['$_refilled', cost] },
        },
      },
      { $unset: ['_lastMs', '_ints', '_refilled', '_lastRf'] },
    ];

    const doc = await this.collection.findOneAndUpdate({ _id: key }, pipeline, {
      upsert: true,
      returnDocument: 'after',
    });

    if (!doc) {
      throw new Error('MongoStore: token bucket increment returned no document');
    }

    const totalHits = Math.round(Number(doc.totalHits));
    const isBlocked = doc.rlfTbBlocked === true;
    const remaining = isBlocked ? 0 : Math.round(Number(doc.tokens));

    try {
      await this.collection.updateOne({ _id: key }, { $unset: { rlfTbBlocked: '' } });
    } catch (err) {
      this.onWarn(
        'MongoStore: failed to strip transient rlfTbBlocked',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    const resetTime =
      doc.resetAt instanceof Date ? doc.resetAt : new Date(doc.resetAt ?? nowMs + interval);

    return {
      totalHits,
      remaining,
      resetTime,
      isBlocked,
    };
  }

  /**
   * Sliding window: array of epoch-ms hits (same idea as {@link PgStore} JSONB).
   *
   * Two `$set` stages are required: the first rewrites `hits` (filter expired + append).
   * The second reads the **updated** `$hits` via `$size` and sets `resetAt` for TTL.
   * Returned `resetTime` is **oldest hit + windowMs** (Rate-Limit-Reset semantics, matching {@link PgStore}),
   * not `doc.resetAt` (TTL field, aligned with newest activity for expiry).
   * A single `$set` cannot reference its own output fields.
   */
  private async incrementSlidingWindow(
    key: string,
    cost: number,
    maxRequests: number,
  ): Promise<RateLimitResult> {
    const now = new Date();
    const nowMs = now.getTime();
    const windowStartMs = nowMs - this.windowMs;
    const nextResetAt = new Date(nowMs + this.windowMs);
    const newHits = Array.from({ length: cost }, () => nowMs);

    const pipeline: Document[] = [
      {
        $set: {
          hits: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ['$hits', []] },
                  as: 'ts',
                  cond: { $gt: ['$$ts', windowStartMs] },
                },
              },
              newHits,
            ],
          },
        },
      },
      {
        $set: {
          totalHits: { $size: '$hits' },
          resetAt: nextResetAt,
        },
      },
    ];

    const result = await this.collection.findOneAndUpdate({ _id: key }, pipeline, {
      upsert: true,
      returnDocument: 'after',
    });

    const doc = result ?? (await this.collection.findOne({ _id: key }));
    const rawTotal = doc?.totalHits ?? cost;
    const totalHits = Math.round(Number(rawTotal));
    const resetTime = resetTimeFromSlidingHits(doc?.hits, this.windowMs, nowMs);
    const isBlocked = totalHits > maxRequests;

    return {
      totalHits,
      remaining: Math.max(0, maxRequests - totalHits),
      resetTime,
      isBlocked,
    };
  }

  private handleError(err: Error, maxRequests: number): RateLimitResult {
    this.onWarn('MongoStore error', err);
    const offsetMs =
      this.strategy === RateLimitStrategy.TOKEN_BUCKET ? this.refillIntervalMs : this.windowMs;
    if (this.onMongoError === 'fail-closed') {
      return {
        totalHits: maxRequests + 1,
        remaining: 0,
        resetTime: new Date(Date.now() + offsetMs),
        isBlocked: true,
        storeUnavailable: true,
      };
    }
    return {
      totalHits: 0,
      remaining: maxRequests,
      resetTime: new Date(Date.now() + offsetMs),
      isBlocked: false,
      storeUnavailable: true,
    };
  }

  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    const prefixedKey = this.keyPrefix + key;
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const bs = this.bucketSize;
    try {
      switch (this.strategy) {
        case RateLimitStrategy.FIXED_WINDOW: {
          await this.collection.findOneAndUpdate(
            { _id: prefixedKey },
            [
              {
                $set: {
                  totalHits: {
                    $max: [0, { $subtract: [{ $ifNull: ['$totalHits', 0] }, cost] }],
                  },
                },
              },
            ],
          );
          break;
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          await this.collection.findOneAndUpdate(
            { _id: prefixedKey },
            [
              {
                $set: {
                  _newTok: {
                    $min: [bs, { $add: [{ $ifNull: ['$tokens', bs] }, cost] }],
                  },
                },
              },
              {
                $set: {
                  tokens: '$_newTok',
                  totalHits: { $subtract: [bs, '$_newTok'] },
                },
              },
              { $unset: ['_newTok'] },
            ],
          );
          break;
        }
        case RateLimitStrategy.SLIDING_WINDOW: {
          await this.decrementSliding(prefixedKey, cost, options?.removeNewest === true);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.onWarn('MongoStore decrement failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onMongoError === 'fail-closed') {
        throw err;
      }
    }
  }

  /**
   * Sliding decrement: two `$set` stages — first trims `hits`, second sets `totalHits` from the new array.
   * Default (**FIFO**): drop the oldest `cost` entries (slice from offset `cost`).
   * **`removeNewest: true`**: drop the newest `cost` entries (slice `[0, size − cost]`), matching the
   * end-trim pipeline pattern.
   */
  private async decrementSliding(key: string, cost: number, removeNewest: boolean): Promise<void> {
    const hitsArr = { $ifNull: ['$hits', []] };
    const hitSize = { $size: hitsArr };

    const fifoPipeline: Document[] = [
      {
        $set: {
          hits: {
            $cond: {
              if: { $lte: [hitSize, cost] },
              then: [],
              else: {
                $slice: [hitsArr, cost, { $subtract: [hitSize, cost] }],
              },
            },
          },
        },
      },
      { $set: { totalHits: { $size: '$hits' } } },
    ];

    const lifoPipeline: Document[] = [
      {
        $set: {
          hits: {
            $slice: [
              hitsArr,
              0,
              { $max: [0, { $subtract: [hitSize, cost] }] },
            ],
          },
        },
      },
      { $set: { totalHits: { $size: '$hits' } } },
    ];

    await this.collection.findOneAndUpdate(
      { _id: key },
      removeNewest ? lifoPipeline : fifoPipeline,
    );
  }

  async reset(key: string): Promise<void> {
    const prefixedKey = this.keyPrefix + key;
    try {
      await this.collection.deleteOne({ _id: prefixedKey });
    } catch (err) {
      this.onWarn('MongoStore reset failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onMongoError === 'fail-closed') {
        throw err;
      }
    }
  }

  async get(key: string): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null> {
    const prefixedKey = this.keyPrefix + key;
    const nowMs = Date.now();
    try {
      const doc = await this.collection.findOne({ _id: prefixedKey });
      if (!doc) {
        return null;
      }

      if (this.strategy === RateLimitStrategy.FIXED_WINDOW) {
        const ra = doc.resetAt;
        const resetAtMs = ra instanceof Date ? ra.getTime() : new Date(String(ra)).getTime();
        if (resetAtMs <= nowMs) {
          return null;
        }
        const totalHits = Math.round(num(doc.totalHits));
        const cap = this.maxRequests;
        const isBlocked = totalHits > cap;
        const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
        return {
          totalHits,
          remaining,
          resetTime: new Date(resetAtMs),
          isBlocked,
        };
      }

      if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
        let tokens = num(doc.tokens);
        const lrRaw = doc.lastRefillAt;
        const lastRefillMs =
          lrRaw instanceof Date ? lrRaw.getTime() : new Date(String(lrRaw)).getTime();
        if (!Number.isFinite(tokens) || !Number.isFinite(lastRefillMs)) {
          return null;
        }
        const ref = refillBucketState(
          tokens,
          lastRefillMs,
          nowMs,
          this.bucketSize,
          this.tokensPerInterval,
          this.refillIntervalMs,
        );
        tokens = ref.tokens;
        const totalHits = this.bucketSize - tokens;
        const remaining = tokens;
        const isBlocked = remaining === 0 && totalHits >= this.bucketSize;
        const resetTime = new Date(ref.lastRefillMs + this.refillIntervalMs);
        return { totalHits, remaining, resetTime, isBlocked };
      }

      if (this.strategy === RateLimitStrategy.SLIDING_WINDOW) {
        const cutoff = nowMs - this.windowMs;
        const stamps = parseHitsArray(doc.hits).filter((ts) => ts > cutoff);
        if (stamps.length === 0) {
          return null;
        }
        const cap = this.maxRequests;
        const totalHits = stamps.length;
        const isBlocked = totalHits > cap;
        const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
        const resetTime = resetTimeDateFromSlidingStamps(stamps, this.windowMs, nowMs);
        return { totalHits, remaining, resetTime, isBlocked };
      }

      const _: never = this.strategy;
      throw new Error(`MongoStore get: unsupported strategy ${String(_)}`);
    } catch (err) {
      this.onWarn('MongoStore get failed', err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  /**
   * Quota state for {@link set} from inputs only — matches persisted semantics when the write succeeds,
   * and is returned on fail-open when MongoDB errors.
   */
  private buildSetResultWithoutPersist(
    n: number,
    expiresAt: Date | undefined,
    nowMs: number,
  ): {
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } {
    switch (this.strategy) {
      case RateLimitStrategy.FIXED_WINDOW: {
        const cap = this.maxRequests;
        const resetAt = expiresAt ?? new Date(nowMs + this.windowMs);
        const isBlocked = n > cap;
        const remaining = isBlocked ? 0 : Math.max(0, cap - n);
        return {
          totalHits: n,
          remaining,
          resetTime: resetAt,
          isBlocked,
        };
      }
      case RateLimitStrategy.TOKEN_BUCKET: {
        const cap = this.bucketSize;
        const blocked = n >= cap;
        const tokens = blocked ? 0 : Math.max(0, cap - n);
        const totalHitsOut = blocked ? cap : n;
        const resetTime = new Date(nowMs + this.refillIntervalMs);
        return {
          totalHits: totalHitsOut,
          remaining: tokens,
          resetTime,
          isBlocked: blocked,
        };
      }
      case RateLimitStrategy.SLIDING_WINDOW: {
        const cap = this.maxRequests;
        const isBlocked = n > cap;
        const remaining = isBlocked ? 0 : Math.max(0, cap - n);
        return {
          totalHits: n,
          remaining,
          resetTime: expiresAt ?? new Date(nowMs + this.windowMs),
          isBlocked,
        };
      }
      default: {
        const _: never = this.strategy;
        throw new Error(`MongoStore.set: unsupported strategy ${String(_)}`);
      }
    }
  }

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
    const prefixedKey = this.keyPrefix + key;
    // One clock read for replaceOne payloads, buildSetResultWithoutPersist, and fail-open returns.
    const nowMs = Date.now();
    const n = Math.max(0, Math.floor(totalHits));

    try {
      switch (this.strategy) {
        case RateLimitStrategy.FIXED_WINDOW: {
          const resetAt = expiresAt ?? new Date(nowMs + this.windowMs);
          await this.collection.replaceOne(
            { _id: prefixedKey },
            {
              totalHits: n,
              resetAt,
            },
            { upsert: true },
          );
          break;
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          const cap = this.bucketSize;
          const blocked = n >= cap;
          const tokens = blocked ? 0 : Math.max(0, cap - n);
          const totalHitsOut = blocked ? cap : n;
          const resetTime = new Date(nowMs + this.refillIntervalMs);
          await this.collection.replaceOne(
            { _id: prefixedKey },
            {
              totalHits: totalHitsOut,
              resetAt: resetTime,
              tokens,
              lastRefillAt: new Date(nowMs),
            },
            { upsert: true },
          );
          break;
        }
        case RateLimitStrategy.SLIDING_WINDOW: {
          const hits = Array.from({ length: n }, () => nowMs);
          const resetAt = expiresAt ?? new Date(nowMs + this.windowMs);
          await this.collection.replaceOne(
            { _id: prefixedKey },
            {
              totalHits: n,
              resetAt,
              hits,
            },
            { upsert: true },
          );
          break;
        }
        default: {
          const _: never = this.strategy;
          throw new Error(`MongoStore.set: unsupported strategy ${String(_)}`);
        }
      }
      return this.buildSetResultWithoutPersist(n, expiresAt, nowMs);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('MongoStore:')) {
        throw err;
      }
      this.onWarn('MongoStore set failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onMongoError === 'fail-closed') {
        throw err;
      }
      return this.buildSetResultWithoutPersist(n, expiresAt, nowMs);
    }
  }

  /**
   * No-op: does not close {@link MongoClient} (caller owns the connection). No timers — TTL index
   * handles document expiry.
   */
  async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  async delete(key: string): Promise<boolean> {
    const prefixedKey = this.keyPrefix + key;
    try {
      const r = await this.collection.deleteOne({ _id: prefixedKey });
      return r.deletedCount > 0;
    } catch (err) {
      this.onWarn('MongoStore delete failed', err instanceof Error ? err : new Error(String(err)));
      if (this.onMongoError === 'fail-closed') {
        throw err;
      }
      return false;
    }
  }
}
