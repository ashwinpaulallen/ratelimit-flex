import { MongoStore } from '../stores/mongo/MongoStore.js';
import type { MongoStoreClient, MongoStoreOptions } from '../stores/mongo/types.js';
import type {
  RateLimitOptions,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';

/**
 * Map merged preset options to {@link MongoStoreOptions} so window and token-bucket fields from `overrides` are not dropped.
 */
function buildPresetMongoStoreOptions(
  mongo: MongoStoreClient,
  merged: Partial<RateLimitOptions>,
  extras?: Pick<MongoStoreOptions, 'onMongoError'>,
): MongoStoreOptions {
  const strategy = merged.strategy ?? RateLimitStrategy.SLIDING_WINDOW;

  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const tb = merged as Partial<TokenBucketRateLimitOptions>;
    const win = merged as Partial<WindowRateLimitOptions>;
    return {
      mongo,
      ...extras,
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: Math.max(1, Math.floor(tb.tokensPerInterval ?? 10)),
      interval: sanitizeWindowMs(tb.interval, 60_000),
      bucketSize: sanitizeRateLimitCap(tb.bucketSize, 100),
      windowMs: sanitizeWindowMs(win.windowMs, 60_000),
      maxRequests: sanitizeRateLimitCap(
        typeof win.maxRequests === 'number' ? win.maxRequests : undefined,
        100,
      ),
    };
  }

  const w = merged as Partial<WindowRateLimitOptions>;
  return {
    mongo,
    ...extras,
    strategy: w.strategy ?? RateLimitStrategy.SLIDING_WINDOW,
    windowMs: sanitizeWindowMs(w.windowMs, 60_000),
    maxRequests: sanitizeRateLimitCap(
      typeof w.maxRequests === 'number' ? w.maxRequests : undefined,
      100,
    ),
  };
}

/**
 * Distributed preset: {@link MongoStore}, sliding window, **100 req / minute**, draft-6 headers, in-memory shield on by default.
 *
 * @param mongoOptions - {@link MongoStoreClient} (`client` + optional `dbName` / `collectionName`, or `db`, or `collection`).
 * @param overrides - Merged after defaults; may replace `store`, limits, headers, etc. For {@link RateLimitStrategy.TOKEN_BUCKET}, pass **`tokensPerInterval`**, **`interval`**, and **`bucketSize`** so {@link MongoStore} matches.
 * @returns Partial {@link RateLimitOptions} with a {@link MongoStore}.
 * @example
 * ```ts
 * import { expressRateLimiter, mongoPreset } from 'ratelimit-flex/mongo';
 * const client = new MongoClient(process.env.MONGODB_URI!);
 * await client.connect();
 * app.use(expressRateLimiter(mongoPreset({ client, dbName: 'myapp' }, { maxRequests: 500 })));
 * ```
 * @since 3.3.0
 */
export function mongoPreset(
  mongoOptions: MongoStoreClient,
  overrides?: Partial<RateLimitOptions>,
): Partial<RateLimitOptions> {
  const defaults: Partial<RateLimitOptions> = {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
  };
  const merged: Partial<RateLimitOptions> = { ...defaults, ...overrides };
  const store = merged.store ?? new MongoStore(buildPresetMongoStoreOptions(mongoOptions, merged));
  return { ...merged, store };
}
