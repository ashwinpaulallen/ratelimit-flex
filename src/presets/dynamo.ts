import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoStoreOptions } from '../stores/dynamo/types.js';
import { DynamoStore } from '../stores/dynamo/DynamoStore.js';
import type {
  RateLimitOptions,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { sanitizeRateLimitCap, sanitizeWindowMs } from '../utils/clamp.js';

function buildDynamoStoreOptions(
  client: DynamoDBDocumentClient,
  tableName: string,
  merged: Partial<RateLimitOptions>,
): DynamoStoreOptions {
  const strategy = merged.strategy ?? RateLimitStrategy.FIXED_WINDOW;

  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    const tb = merged as Partial<TokenBucketRateLimitOptions>;
    const win = merged as Partial<WindowRateLimitOptions>;
    return {
      client,
      tableName,
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
    client,
    tableName,
    strategy: w.strategy ?? RateLimitStrategy.FIXED_WINDOW,
    windowMs: sanitizeWindowMs(w.windowMs, 60_000),
    maxRequests: sanitizeRateLimitCap(
      typeof w.maxRequests === 'number' ? w.maxRequests : undefined,
      100,
    ),
  };
}

/**
 * Distributed preset: {@link DynamoStore}, **fixed window** (exact in DynamoDB) by default, **100 req / minute**, draft-6 headers, in-memory shield on by default.
 *
 * @description Defaults to {@link RateLimitStrategy.FIXED_WINDOW} so the out-of-the-box experience is **exact** counting on DynamoDB. Unlike {@link postgresPreset} / {@link mongoPreset} (which default to sliding), this surfaces fixed window first — use **`strategy: SLIDING_WINDOW`** when you accept DynamoDB’s weighted approximation.
 * @param dynamoOptions - Document client and table name (create the table and enable TTL; see {@link DynamoStore}).
 * @param overrides - Merged after defaults; may set `strategy`, `store`, limits, headers, etc.
 * @returns Partial {@link RateLimitOptions} with a {@link DynamoStore}.
 * @since 3.3.0
 */
export function dynamoPreset(
  dynamoOptions: { client: DynamoDBDocumentClient; tableName: string },
  overrides?: Partial<RateLimitOptions>,
): Partial<RateLimitOptions> {
  const defaults: Partial<RateLimitOptions> = {
    maxRequests: 100,
    windowMs: 60_000,
    strategy: RateLimitStrategy.FIXED_WINDOW,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    inMemoryBlock: true,
  };
  const merged: Partial<RateLimitOptions> = { ...defaults, ...overrides };
  const store =
    merged.store ??
    new DynamoStore(
      buildDynamoStoreOptions(dynamoOptions.client, dynamoOptions.tableName, merged),
    );
  return { ...merged, store };
}
