import type { Collection, Db, MongoClient } from 'mongodb';

import type { RateLimitStrategy } from '../../types/index.js';

/**
 * Accept any of: MongoClient (we'll pick the default DB),
 * Db (we'll create/use our collection), or Collection (use directly).
 * This matches how real apps wire up MongoDB.
 */
export type MongoStoreClient =
  | { client: MongoClient; dbName?: string; collectionName?: string }
  | { db: Db; collectionName?: string }
  | { collection: Collection };

export interface MongoStoreOptions {
  /** MongoDB client/db/collection. */
  mongo: MongoStoreClient;

  strategy?: RateLimitStrategy;
  windowMs?: number;
  maxRequests?: number;
  tokensPerInterval?: number;
  interval?: number;
  bucketSize?: number;

  /** Key prefix. Default: 'rlf:'. */
  keyPrefix?: string;

  /**
   * Whether to ensure the TTL index on resetAt exists.
   * Default: true. Set to false if you manage indexes externally.
   * The index is created with expireAfterSeconds: 0, so documents are
   * removed by MongoDB's background TTL monitor when resetAt <= now().
   */
  ensureIndexes?: boolean;

  onMongoError?: 'fail-open' | 'fail-closed';
  onWarn?: (msg: string, err?: Error) => void;
}

/**
 * Document shape stored in the collection.
 * Different strategies use different fields.
 */
export interface RateLimitDocument {
  _id: string; // the prefixed key
  totalHits: number;
  resetAt: Date; // TTL field
  // Sliding window only
  hits?: number[]; // epoch ms timestamps
  // Token bucket only
  tokens?: number;
  lastRefillAt?: Date;
  /**
   * Set only transiently during {@link MongoStore} token-bucket increment, then removed — not part of the stable schema.
   */
  rlfTbBlocked?: boolean;
}

