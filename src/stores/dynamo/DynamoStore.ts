import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  ProvisionedThroughputExceededException,
  RequestLimitExceeded,
  ThrottlingException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  type DynamoDBDocumentClient as DynamoDBDocumentClientType,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../../types/index.js';
import { RateLimitStrategy } from '../../types/index.js';
import { sanitizeIncrementCost, sanitizeRateLimitCap, sanitizeWindowMs } from '../../utils/clamp.js';
import { num, refillBucketState } from '../../utils/store-utils.js';
import {
  fixedWindowBoundaryMs,
  ttlEpochSeconds,
  weightedSlidingCount,
} from './sliding-weighted.js';
import type { DynamoStoreOptions } from './types.js';

function isConditionalCheckFailure(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException;
}

function isThrottlingError(err: unknown): boolean {
  return (
    err instanceof ProvisionedThroughputExceededException ||
    err instanceof ThrottlingException ||
    err instanceof RequestLimitExceeded
  );
}

function toDocumentClient(
  client: DynamoDBClient | DynamoDBDocumentClientType,
): DynamoDBDocumentClientType {
  return client instanceof DynamoDBClient
    ? DynamoDBDocumentClient.from(client)
    : client;
}

function shouldFailOpen(onDynamoError: 'fail-open' | 'fail-closed'): boolean {
  return onDynamoError === 'fail-open';
}

/**
 * DynamoDB-backed rate limit store.
 *
 * @description
 * This library does **not** call `CreateTable` or `UpdateTimeToLive` at runtime. You must:
 *
 * 1. **Create the table** using `dynamoStoreTableSchema` from `./schema.js` (or equivalent in AWS CDK, Terraform, CloudFormation, etc.).
 * 2. **Enable TTL** on the table for the expiry attribute (default name `ttl`) — see `dynamoStoreEnableTtlParams` in `./schema.js`.
 * 3. **Pass the table name** via {@link DynamoStoreOptions.tableName} when constructing this store (and {@link DynamoStoreOptions.ttlAttribute} if your TTL attribute is not named `ttl`).
 *
 * **Default `strategy`:** {@link RateLimitStrategy.FIXED_WINDOW} when {@link DynamoStoreOptions.strategy}
 * is omitted — exact counting on DynamoDB, aligned with {@link dynamoPreset}. Pass
 * {@link RateLimitStrategy.SLIDING_WINDOW} explicitly for the weighted (approximate) sliding algorithm.
 *
 * DynamoStore's SLIDING_WINDOW strategy is APPROXIMATE. It uses a weighted
 * sub-window algorithm that trades exactness for atomicity in a single
 * UpdateItem call. Max error: ~10% near window boundaries. Typical error:
 * &lt;2% under steady traffic. For exact sliding window, use PgStore,
 * MongoStore, or RedisStore.
 *
 * Throttling (`ProvisionedThroughputExceededException`, `ThrottlingException`, etc.) is
 * handled like other DynamoDB errors via {@link DynamoStoreOptions.onDynamoError} — this
 * library does not add automatic retries (configure the SDK client instead).
 *
 * @since 3.3.0
 */
export class DynamoStore implements RateLimitStore {
  private readonly doc: DynamoDBDocumentClientType;

  private readonly tableName: string;

  private readonly strategy: RateLimitStrategy;

  private readonly windowMs: number;

  private readonly maxRequests: number;

  private readonly tokensPerInterval: number;

  private readonly refillIntervalMs: number;

  private readonly bucketSize: number;

  private readonly keyPrefix: string;

  private readonly ttlAttribute: string;

  private readonly onDynamoError: 'fail-open' | 'fail-closed';

  private readonly onWarn: (msg: string, err?: Error) => void;

  constructor(options: DynamoStoreOptions) {
    if (!options.client) {
      throw new Error('DynamoStore: "client" is required');
    }
    if (!options.tableName) {
      throw new Error('DynamoStore: "tableName" is required');
    }
    this.doc = toDocumentClient(options.client);
    this.tableName = options.tableName;
    this.strategy = options.strategy ?? RateLimitStrategy.FIXED_WINDOW;
    this.windowMs = sanitizeWindowMs(options.windowMs, 60_000);
    this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
    this.tokensPerInterval = Math.max(1, Math.floor(options.tokensPerInterval ?? 10));
    this.refillIntervalMs = sanitizeWindowMs(options.interval, 60_000);
    this.bucketSize = sanitizeRateLimitCap(options.bucketSize, 100);
    this.keyPrefix = options.keyPrefix ?? 'rlf:';
    this.ttlAttribute = options.ttlAttribute ?? 'ttl';
    this.onDynamoError = options.onDynamoError ?? 'fail-open';
    this.onWarn =
      options.onWarn ?? ((msg, err) => console.warn(`[ratelimit-flex] ${msg}`, err ?? ''));
  }

  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    const cap =
      this.strategy === RateLimitStrategy.TOKEN_BUCKET
        ? this.bucketSize
        : sanitizeRateLimitCap(options?.maxRequests ?? this.maxRequests, this.maxRequests);
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const now = Date.now();
    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW:
          return await this.incrementSliding(key, cap, cost, now);
        case RateLimitStrategy.FIXED_WINDOW:
          return await this.incrementFixed(key, cap, cost, now);
        case RateLimitStrategy.TOKEN_BUCKET:
          return await this.incrementTokenBucket(key, cost, now);
        default: {
          const exhaustive: never = this.strategy;
          throw new Error(`DynamoStore: unsupported strategy ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      if (this.isProgrammerError(err)) {
        throw err;
      }
      this.warn('DynamoDB increment failed', err);
      if (!shouldFailOpen(this.onDynamoError)) {
        return this.failClosedIncrementResult(cap, now);
      }
      return this.failOpenIncrementResult(cap, now);
    }
  }

  private async incrementSliding(
    key: string,
    cap: number,
    cost: number,
    now: number,
  ): Promise<RateLimitResult> {
    const thisBoundary = fixedWindowBoundaryMs(now, this.windowMs);
    const prevBoundary = thisBoundary - this.windowMs;
    const pk = `${this.keyPrefix}${key}`;
    const ttlSec = ttlEpochSeconds(now, this.windowMs);
    const ttlName = `#ttl_${this.ttlAttribute.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const exprNames: Record<string, string> = {
      [ttlName]: this.ttlAttribute,
    };

    const attrs = await this.runSlidingIncrementMutation({
      pk,
      cost,
      thisBoundary,
      prevBoundary,
      ttlSec,
      ttlName,
      exprNames,
    });
    return this.slidingResultFromAttributes(attrs, now, cap);
  }

  private async runSlidingIncrementMutation(args: {
    pk: string;
    cost: number;
    thisBoundary: number;
    prevBoundary: number;
    ttlSec: number;
    ttlName: string;
    exprNames: Record<string, string>;
  }): Promise<Record<string, unknown>> {
    const { pk, cost, thisBoundary, prevBoundary, ttlSec, ttlName, exprNames } = args;

    const maxAttempts = 24;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const out = await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk },
            UpdateExpression: `ADD currentCount :cost SET ${ttlName} = :ttl`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: {
              ':cost': cost,
              ':b': thisBoundary,
              ':ttl': ttlSec,
            },
            ConditionExpression: 'currentWindowStart = :b',
            ReturnValues: 'ALL_NEW',
          }),
        );
        return (out.Attributes ?? {}) as Record<string, unknown>;
      } catch (err) {
        if (!isConditionalCheckFailure(err)) {
          throw err;
        }
      }

      try {
        const out = await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk },
            UpdateExpression: `SET previousCount = currentCount, currentCount = :cost, currentWindowStart = :b, ${ttlName} = :ttl`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: {
              ':cost': cost,
              ':b': thisBoundary,
              ':pb': prevBoundary,
              ':ttl': ttlSec,
            },
            ConditionExpression: 'currentWindowStart = :pb',
            ReturnValues: 'ALL_NEW',
          }),
        );
        return (out.Attributes ?? {}) as Record<string, unknown>;
      } catch (err) {
        if (!isConditionalCheckFailure(err)) {
          throw err;
        }
      }

      try {
        const out = await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk },
            UpdateExpression: `SET previousCount = :z, currentCount = :cost, currentWindowStart = :b, ${ttlName} = :ttl`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: {
              ':z': 0,
              ':cost': cost,
              ':b': thisBoundary,
              ':ttl': ttlSec,
            },
            ConditionExpression: 'attribute_not_exists(pk) OR currentWindowStart < :b',
            ReturnValues: 'ALL_NEW',
          }),
        );
        return (out.Attributes ?? {}) as Record<string, unknown>;
      } catch (err) {
        if (isConditionalCheckFailure(err)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('DynamoStore: sliding increment could not commit (too much contention at window boundary)');
  }

  private async incrementFixed(
    key: string,
    cap: number,
    cost: number,
    now: number,
  ): Promise<RateLimitResult> {
    const thisBoundary = fixedWindowBoundaryMs(now, this.windowMs);
    const pk = `${this.keyPrefix}${key}`;
    const ttlSec = ttlEpochSeconds(now, this.windowMs);
    const ttlName = `#ttl_${this.ttlAttribute.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const exprNames: Record<string, string> = { [ttlName]: this.ttlAttribute };

    const maxAttempts = 24;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const out = await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk },
            UpdateExpression: `ADD totalHits :cost SET ${ttlName} = :ttl`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: {
              ':cost': cost,
              ':b': thisBoundary,
              ':ttl': ttlSec,
            },
            ConditionExpression: 'windowStart = :b',
            ReturnValues: 'ALL_NEW',
          }),
        );
        return this.fixedResultFromAttributes((out.Attributes ?? {}) as Record<string, unknown>, cap);
      } catch (err) {
        if (!isConditionalCheckFailure(err)) {
          throw err;
        }
      }

      try {
        const out = await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk },
            UpdateExpression: `SET totalHits = :cost, windowStart = :b, ${ttlName} = :ttl`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: {
              ':cost': cost,
              ':b': thisBoundary,
              ':ttl': ttlSec,
            },
            ConditionExpression: 'attribute_not_exists(pk) OR windowStart < :b',
            ReturnValues: 'ALL_NEW',
          }),
        );
        return this.fixedResultFromAttributes((out.Attributes ?? {}) as Record<string, unknown>, cap);
      } catch (err) {
        if (isConditionalCheckFailure(err)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('DynamoStore: fixed window increment could not commit (too much contention at window boundary)');
  }

  private fixedResultFromAttributes(attrs: Record<string, unknown>, cap: number): RateLimitResult {
    const ws = Number(attrs.windowStart);
    const totalHits = Math.max(0, Math.floor(Number(attrs.totalHits ?? 0)));
    const isBlocked = totalHits > cap;
    const remaining = isBlocked ? 0 : Math.max(0, cap - totalHits);
    const resetTime = new Date(ws + this.windowMs);
    return { totalHits, remaining, isBlocked, resetTime };
  }

  private async incrementTokenBucket(key: string, cost: number, now: number): Promise<RateLimitResult> {
    const pk = `${this.keyPrefix}${key}`;
    const bs = this.bucketSize;
    const tpi = this.tokensPerInterval;
    const interval = this.refillIntervalMs;
    const ttlSec = Math.ceil((now + 3 * interval) / 1000);
    const ttlName = `#ttl_${this.ttlAttribute.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const exprNames: Record<string, string> = { [ttlName]: this.ttlAttribute };

    for (let attempt = 0; attempt < 12; attempt++) {
      const got = await this.doc.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk },
          ConsistentRead: true,
        }),
      );

      let tStored: number;
      let lrStored: number;

      if (!got.Item) {
        tStored = bs;
        lrStored = now;
      } else {
        tStored = num(got.Item.tokens);
        lrStored = num(got.Item.lastRefillAt);
        if (!Number.isFinite(tStored) || !Number.isFinite(lrStored)) {
          tStored = bs;
          lrStored = now;
        }
      }

      const refilled = refillBucketState(tStored, lrStored, now, bs, tpi, interval);

      let newTokens: number;
      let newLastRefillMs: number;
      let isBlocked: boolean;
      let resetTime: Date;

      if (refilled.tokens >= cost) {
        newTokens = refilled.tokens - cost;
        newLastRefillMs = refilled.lastRefillMs;
        isBlocked = false;
        resetTime = new Date(newLastRefillMs + interval);
      } else {
        newTokens = refilled.tokens;
        newLastRefillMs = refilled.lastRefillMs;
        isBlocked = true;
        resetTime = new Date(newLastRefillMs + interval);
      }

      const totalHits = isBlocked ? bs : bs - newTokens;
      const remaining = isBlocked ? 0 : newTokens;

      try {
        if (!got.Item) {
          await this.doc.send(
            new PutCommand({
              TableName: this.tableName,
              Item: {
                pk,
                tokens: newTokens,
                lastRefillAt: newLastRefillMs,
                [this.ttlAttribute]: ttlSec,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            }),
          );
        } else {
          await this.doc.send(
            new UpdateCommand({
              TableName: this.tableName,
              Key: { pk },
              UpdateExpression: `SET tokens = :tok, lastRefillAt = :lr, ${ttlName} = :ttl`,
              ExpressionAttributeNames: exprNames,
              ExpressionAttributeValues: {
                ':tok': newTokens,
                ':lr': newLastRefillMs,
                ':ttl': ttlSec,
                ':ot': tStored,
                ':olr': lrStored,
              },
              ConditionExpression: 'tokens = :ot AND lastRefillAt = :olr',
            }),
          );
        }

        return {
          totalHits,
          remaining,
          resetTime,
          isBlocked,
        };
      } catch (err) {
        if (isConditionalCheckFailure(err)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('DynamoStore: token bucket increment could not commit (too much contention)');
  }

  private slidingResultFromAttributes(
    attrs: Record<string, unknown>,
    now: number,
    cap: number,
  ): RateLimitResult {
    const cws = Number(attrs.currentWindowStart);
    const pc = Number(attrs.previousCount ?? 0);
    const cc = Number(attrs.currentCount ?? 0);
    const raw = weightedSlidingCount(pc, cc, now, this.windowMs, cws);
    const totalHits = Math.ceil(raw);
    const isBlocked = raw > cap;
    const remaining = Math.max(0, cap - Math.ceil(raw));
    const resetTime = new Date(cws + this.windowMs);
    return { totalHits, remaining, isBlocked, resetTime };
  }

  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    const cost = sanitizeIncrementCost(options?.cost, 1);
    const neg = -cost;
    const pk = `${this.keyPrefix}${key}`;
    const now = Date.now();
    const thisBoundary = fixedWindowBoundaryMs(now, this.windowMs);
    const ttlName = `#ttl_${this.ttlAttribute.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const exprNames: Record<string, string> = { [ttlName]: this.ttlAttribute };

    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW: {
          if (options?.removeNewest === true) {
            this.warn(
              'DynamoStore: removeNewest sliding decrement is not supported; applying current-window ADD only',
            );
          }
          try {
            const out = await this.doc.send(
              new UpdateCommand({
                TableName: this.tableName,
                Key: { pk },
                UpdateExpression: 'ADD currentCount :neg',
                ExpressionAttributeValues: {
                  ':neg': neg,
                  ':b': thisBoundary,
                },
                ConditionExpression: 'currentWindowStart = :b',
                ReturnValues: 'ALL_NEW',
              }),
            );
            const cc = Number((out.Attributes as Record<string, unknown> | undefined)?.currentCount ?? 0);
            if (cc < 0) {
              try {
                await this.doc.send(
                  new UpdateCommand({
                    TableName: this.tableName,
                    Key: { pk },
                    UpdateExpression: 'SET currentCount = :z',
                    ExpressionAttributeValues: {
                      ':z': 0,
                      ':b': thisBoundary,
                      ':zero': 0,
                    },
                    ConditionExpression: 'currentWindowStart = :b AND currentCount < :zero',
                  }),
                );
              } catch (clampErr) {
                if (!isConditionalCheckFailure(clampErr)) {
                  throw clampErr;
                }
                // Concurrent increment may have brought the count back ≥ 0; clamp is a no-op.
              }
            }
          } catch (err) {
            if (isConditionalCheckFailure(err)) {
              return;
            }
            throw err;
          }
          break;
        }
        case RateLimitStrategy.FIXED_WINDOW: {
          try {
            const out = await this.doc.send(
              new UpdateCommand({
                TableName: this.tableName,
                Key: { pk },
                UpdateExpression: 'ADD totalHits :neg',
                ExpressionAttributeValues: {
                  ':neg': neg,
                  ':b': thisBoundary,
                },
                ConditionExpression: 'windowStart = :b',
                ReturnValues: 'ALL_NEW',
              }),
            );
            const th = Number((out.Attributes as Record<string, unknown> | undefined)?.totalHits ?? 0);
            if (th < 0) {
              try {
                await this.doc.send(
                  new UpdateCommand({
                    TableName: this.tableName,
                    Key: { pk },
                    UpdateExpression: 'SET totalHits = :z',
                    ExpressionAttributeValues: {
                      ':z': 0,
                      ':b': thisBoundary,
                      ':zero': 0,
                    },
                    ConditionExpression: 'windowStart = :b AND totalHits < :zero',
                  }),
                );
              } catch (clampErr) {
                if (!isConditionalCheckFailure(clampErr)) {
                  throw clampErr;
                }
              }
            }
          } catch (err) {
            if (isConditionalCheckFailure(err)) {
              return;
            }
            throw err;
          }
          break;
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          try {
            const out = await this.doc.send(
              new UpdateCommand({
                TableName: this.tableName,
                Key: { pk },
                UpdateExpression: `ADD tokens :cost SET ${ttlName} = :ttl`,
                ExpressionAttributeNames: exprNames,
                ExpressionAttributeValues: {
                  ':cost': cost,
                  ':ttl': Math.ceil((now + 3 * this.refillIntervalMs) / 1000),
                },
                ConditionExpression: 'attribute_exists(pk)',
                ReturnValues: 'ALL_NEW',
              }),
            );
            const tok = Number((out.Attributes as Record<string, unknown> | undefined)?.tokens ?? 0);
            if (tok > this.bucketSize) {
              try {
                await this.doc.send(
                  new UpdateCommand({
                    TableName: this.tableName,
                    Key: { pk },
                    UpdateExpression: 'SET tokens = :bs',
                    ExpressionAttributeValues: {
                      ':bs': this.bucketSize,
                    },
                    ConditionExpression: 'tokens > :bs',
                  }),
                );
              } catch (clampErr) {
                if (!isConditionalCheckFailure(clampErr)) {
                  throw clampErr;
                }
                // Concurrent increment may have brought tokens back within the cap; clamp is a no-op.
              }
            }
          } catch (err) {
            if (isConditionalCheckFailure(err)) {
              return;
            }
            throw err;
          }
          break;
        }
        default: {
          const exhaustive: never = this.strategy;
          throw new Error(`DynamoStore: unsupported strategy ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      if (this.isProgrammerError(err)) {
        throw err;
      }
      this.warn('DynamoDB decrement failed', err);
      if (!shouldFailOpen(this.onDynamoError)) {
        throw err;
      }
    }
  }

  async reset(key: string): Promise<void> {
    const pk = `${this.keyPrefix}${key}`;
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk },
        }),
      );
    } catch (err) {
      if (this.isProgrammerError(err)) {
        throw err;
      }
      this.warn('DynamoDB reset failed', err);
      if (isThrottlingError(err)) {
        if (!shouldFailOpen(this.onDynamoError)) {
          throw err;
        }
        return;
      }
      if (!shouldFailOpen(this.onDynamoError)) {
        throw err;
      }
    }
  }

  async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  async get(key: string): Promise<{
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } | null> {
    const pk = `${this.keyPrefix}${key}`;
    const cap = this.maxRequests;
    const now = Date.now();
    try {
      const got = await this.doc.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk },
        }),
      );
      if (!got.Item) {
        return null;
      }
      const item = got.Item as Record<string, unknown>;
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW: {
          const cws = Number(item.currentWindowStart);
          if (!Number.isFinite(cws) || cws + 2 * this.windowMs <= now) {
            return null;
          }
          return this.slidingResultFromAttributes(item, now, cap);
        }
        case RateLimitStrategy.FIXED_WINDOW: {
          const ws = Number(item.windowStart);
          if (!Number.isFinite(ws) || now >= ws + this.windowMs) {
            return null;
          }
          return this.fixedResultFromAttributes(item, cap);
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          let tokens = num(item.tokens);
          let lastRefillMs = num(item.lastRefillAt);
          if (!Number.isFinite(tokens) || !Number.isFinite(lastRefillMs)) {
            return null;
          }
          const ref = refillBucketState(
            tokens,
            lastRefillMs,
            now,
            this.bucketSize,
            this.tokensPerInterval,
            this.refillIntervalMs,
          );
          tokens = ref.tokens;
          lastRefillMs = ref.lastRefillMs;
          const remaining = tokens;
          const totalHits = this.bucketSize - remaining;
          const isBlocked = remaining === 0 && totalHits >= this.bucketSize;
          return {
            totalHits,
            remaining,
            resetTime: new Date(lastRefillMs + this.refillIntervalMs),
            isBlocked,
          };
        }
        default: {
          const exhaustive: never = this.strategy;
          throw new Error(`DynamoStore: unsupported strategy ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      if (this.isProgrammerError(err)) {
        throw err;
      }
      this.warn('DynamoDB get failed', err);
      if (isThrottlingError(err)) {
        if (!shouldFailOpen(this.onDynamoError)) {
          throw err;
        }
        return null;
      }
      if (!shouldFailOpen(this.onDynamoError)) {
        throw err;
      }
      return null;
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
    const pk = `${this.keyPrefix}${key}`;
    const n = Math.max(0, Math.floor(totalHits));
    const now = Date.now();
    const ttlSec = Math.ceil((now + 3 * (this.strategy === RateLimitStrategy.TOKEN_BUCKET ? this.refillIntervalMs : this.windowMs)) / 1000);

    try {
      switch (this.strategy) {
        case RateLimitStrategy.SLIDING_WINDOW: {
          const cap = this.maxRequests;
          const thisBoundary = fixedWindowBoundaryMs(now, this.windowMs);
          const isBlocked = n > cap;
          const remaining = isBlocked ? 0 : Math.max(0, cap - n);
          const resetTime = new Date(thisBoundary + this.windowMs);
          await this.doc.send(
            new PutCommand({
              TableName: this.tableName,
              Item: {
                pk,
                currentWindowStart: thisBoundary,
                previousCount: 0,
                currentCount: n,
                [this.ttlAttribute]: ttlSec,
              },
            }),
          );
          return { totalHits: n, remaining, resetTime, isBlocked };
        }
        case RateLimitStrategy.FIXED_WINDOW: {
          const cap = this.maxRequests;
          const thisBoundary = fixedWindowBoundaryMs(now, this.windowMs);
          const resetMs = expiresAt?.getTime() ?? thisBoundary + this.windowMs;
          const isBlocked = n > cap;
          const remaining = isBlocked ? 0 : Math.max(0, cap - n);
          await this.doc.send(
            new PutCommand({
              TableName: this.tableName,
              Item: {
                pk,
                windowStart: thisBoundary,
                totalHits: n,
                [this.ttlAttribute]: ttlSec,
              },
            }),
          );
          return {
            totalHits: n,
            remaining,
            resetTime: new Date(resetMs),
            isBlocked,
          };
        }
        case RateLimitStrategy.TOKEN_BUCKET: {
          const cap = this.bucketSize;
          const isBlocked = n >= cap;
          const tokens = isBlocked ? 0 : Math.max(0, cap - n);
          const totalHitsOut = isBlocked ? cap : n;
          await this.doc.send(
            new PutCommand({
              TableName: this.tableName,
              Item: {
                pk,
                tokens,
                lastRefillAt: now,
                [this.ttlAttribute]: ttlSec,
              },
            }),
          );
          return {
            totalHits: totalHitsOut,
            remaining: tokens,
            resetTime: new Date(now + this.refillIntervalMs),
            isBlocked,
          };
        }
        default: {
          const exhaustive: never = this.strategy;
          throw new Error(`DynamoStore: unsupported strategy ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      if (this.isProgrammerError(err)) {
        throw err;
      }
      this.warn('DynamoDB set failed', err);
      if (isThrottlingError(err)) {
        if (!shouldFailOpen(this.onDynamoError)) {
          throw err;
        }
        return this.failOpenSetResult(n, now);
      }
      if (!shouldFailOpen(this.onDynamoError)) {
        throw err;
      }
      return this.failOpenSetResult(n, now);
    }
  }

  private failOpenSetResult(n: number, now: number): {
    totalHits: number;
    remaining: number;
    resetTime: Date;
    isBlocked: boolean;
  } {
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      const cap = this.bucketSize;
      const isBlocked = n >= cap;
      const tokens = isBlocked ? 0 : Math.max(0, cap - n);
      const totalHitsOut = isBlocked ? cap : n;
      return {
        totalHits: totalHitsOut,
        remaining: tokens,
        resetTime: new Date(now + this.refillIntervalMs),
        isBlocked,
      };
    }
    const cap = this.maxRequests;
    const isBlocked = n > cap;
    return {
      totalHits: n,
      remaining: isBlocked ? 0 : Math.max(0, cap - n),
      resetTime: new Date(now + this.windowMs),
      isBlocked,
    };
  }

  async delete(key: string): Promise<boolean> {
    const pk = `${this.keyPrefix}${key}`;
    try {
      const out = await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk },
          ReturnValues: 'ALL_OLD',
        }),
      );
      return out.Attributes !== undefined;
    } catch (err) {
      if (this.isProgrammerError(err)) {
        throw err;
      }
      this.warn('DynamoDB delete failed', err);
      if (isThrottlingError(err)) {
        if (!shouldFailOpen(this.onDynamoError)) {
          throw err;
        }
        return false;
      }
      if (!shouldFailOpen(this.onDynamoError)) {
        throw err;
      }
      return false;
    }
  }

  private failOpenIncrementResult(cap: number, now: number): RateLimitResult {
    if (this.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return {
        totalHits: 0,
        remaining: this.bucketSize,
        resetTime: new Date(now + this.refillIntervalMs),
        isBlocked: false,
      };
    }
    return {
      totalHits: 0,
      remaining: cap,
      resetTime: new Date(now + this.windowMs),
      isBlocked: false,
    };
  }

  private failClosedIncrementResult(cap: number, now: number): RateLimitResult {
    const offsetMs =
      this.strategy === RateLimitStrategy.TOKEN_BUCKET ? this.refillIntervalMs : this.windowMs;
    return {
      totalHits: cap + 1,
      remaining: 0,
      resetTime: new Date(now + offsetMs),
      isBlocked: true,
      storeUnavailable: true,
    };
  }

  private warn(msg: string, err?: unknown): void {
    this.onWarn(msg, err instanceof Error ? err : err === undefined ? undefined : new Error(String(err)));
  }

  /**
   * Internal errors prefixed with `DynamoStore:` must not become fail-open / fail-closed quota
   * (same idea as {@link PgStore.isNonPostgresError} / MongoStore `MongoStore:` rethrow).
   */
  private isProgrammerError(err: unknown): boolean {
    return err instanceof Error && err.message.startsWith('DynamoStore:');
  }
}
